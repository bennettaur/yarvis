import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  clearPendingIssuePrompt,
  createRepo,
  createWorkspace,
  deleteRepo,
  findWorkspaceForPr,
  getRepo,
  getWorkspace,
  linkIssue,
  linkTask,
  listRepoBranches,
  listRepos,
  listWorkspaces,
  type ProvisionEvent,
  provisionWorkspace,
  startArchiveWorkspace,
  unlinkIssue,
  unlinkTask,
  updateRepo,
  workspaceRepoChanges,
  workspaceRepoFileDiff,
  workspaceRepoFiles,
  workspaceRepoSync,
} from "./service.ts";

const createRepoSchema = z.object({
  cloneUrl: z.string().min(1),
  name: z.string().min(1).optional(),
  setupScript: z.string().nullish(),
  runScript: z.string().nullish(),
  pullIssues: z.boolean().optional(),
});

const updateRepoSchema = z.object({
  name: z.string().min(1).optional(),
  cloneUrl: z.string().min(1).optional(),
  setupScript: z.string().nullish(),
  runScript: z.string().nullish(),
  pullIssues: z.boolean().optional(),
});

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  // Empty is allowed: a scratch workspace (just a folder to run Claude in).
  repoIds: z.array(z.string().uuid()).default([]),
  // repo id -> existing branch to check out instead of a fresh branch.
  existingBranches: z.record(z.string().uuid(), z.string()).optional(),
  taskId: z.string().uuid().nullish(),
  // A "Start work" prompt to seed the workspace's agent session with, held on
  // the row until the launch line goes out. Capped like the issue bodies it is
  // composed from (see `createIssueSchema`), now that it is persisted rather
  // than passed straight through.
  issuePrompt: z.string().max(65536).nullish(),
});

const archiveSchema = z.object({
  summary: z.string().nullish(),
  mergedPrUrl: z.string().nullish(),
  force: z.boolean().optional(),
});

// The source-agnostic triple identifying an issue across providers.
const issueRefSchema = z.object({
  provider: z.enum(["github", "jira"]),
  sourceKey: z.string().min(1).max(256),
  externalId: z.string().min(1).max(256),
});

// The stored url is later rendered as an anchor href; restrict it to http(s)
// so a pasted `javascript:`/`file:` URL can't reach the DOM as a link target.
const httpUrl = z
  .string()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), "url must be http(s)");

const linkIssueSchema = issueRefSchema.extend({
  title: z.string().max(1024).nullish(),
  url: httpUrl.nullish(),
});

/** Repo registry CRUD, mounted under /api/repos. */
export function createRepoRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => c.json(await listRepos(db())));

  router.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createRepoSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(await createRepo(db(), config, parsed.data), 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  router.get("/:id", async (c) => {
    const repo = await getRepo(db(), c.req.param("id"));
    if (!repo) return c.json({ error: "not found" }, 404);
    return c.json(repo);
  });

  // Remote branch names, for offering an existing branch when creating a
  // workspace. Ensures the clone exists and fetches first, so it can be slow.
  router.get("/:id/branches", async (c) => {
    const repo = await getRepo(db(), c.req.param("id"));
    if (!repo) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await listRepoBranches(db(), repo.id));
    } catch (e) {
      // A clone/fetch failure (offline, auth) — not a missing repo.
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  router.patch("/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateRepoSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const repo = await updateRepo(db(), c.req.param("id"), parsed.data);
      if (!repo) return c.json({ error: "not found" }, 404);
      return c.json(repo);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  router.delete("/:id", async (c) => {
    try {
      const ok = await deleteRepo(db(), c.req.param("id"));
      if (!ok) return c.json({ error: "not found" }, 404);
      return c.json({ ok: true });
    } catch (e) {
      // FK restrict: the repo is still referenced by a workspace.
      return c.json({ error: "repo is in use by a workspace", detail: String(e) }, 409);
    }
  });

  return router;
}

/** Workspace CRUD + provisioning, mounted under /api/workspaces. */
export function createWorkspaceRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => c.json(await listWorkspaces(db())));

  // The active workspace (if any) a PR was raised from, so the PR view can link
  // back to it. Registered before "/:id" so "for-pr" isn't read as an id.
  // Returns null (200) when there's no match. `provider` selects which identity
  // fields are required (GitHub owner/repo vs Azure org/project/repo).
  router.get("/for-pr", async (c) => {
    const number = Number(c.req.query("number"));
    if (!Number.isInteger(number)) return c.json({ error: "number is required" }, 400);
    const provider = c.req.query("provider") ?? "github";
    if (provider === "azure") {
      const org = c.req.query("org");
      const project = c.req.query("project");
      const repo = c.req.query("repo");
      if (!org || !project || !repo) {
        return c.json({ error: "org, project, and repo are required" }, 400);
      }
      return c.json(
        await findWorkspaceForPr(db(), { provider: "azure", org, project, repo, number }),
      );
    }
    const owner = c.req.query("owner");
    const repo = c.req.query("repo");
    if (!owner || !repo) return c.json({ error: "owner and repo are required" }, 400);
    return c.json(await findWorkspaceForPr(db(), { provider: "github", owner, repo, number }));
  });

  router.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createWorkspaceSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(await createWorkspace(db(), config, parsed.data), 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  router.get("/:id", async (c) => {
    const workspace = await getWorkspace(db(), c.req.param("id"));
    if (!workspace) return c.json({ error: "not found" }, 404);
    return c.json(workspace);
  });

  // Clears the pending "Start work" prompt, called once the workspace's agent
  // session is live and has been handed the ticket.
  router.delete("/:id/issue-prompt", async (c) => {
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "bad workspace id" }, 400);
    await clearPendingIssuePrompt(db(), id.data);
    return c.json({ ok: true });
  });

  // Drives provisioning and streams progress as SSE. The setup script's output
  // arrives as `log` events; the stream ends with a `done` event. Re-driving a
  // workspace already being provisioned follows the run in flight, so reopening
  // a workspace mid-provision picks the log back up rather than failing.
  router.post("/:id/provision", async (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const emit = (event: ProvisionEvent) => stream.writeSSE({ data: JSON.stringify(event) });
      // Lets a caller that is only following someone else's run stop following
      // when its stream closes. The run itself is deliberately not cancelled:
      // finishing it without an audience is the whole point.
      const gone = new AbortController();
      stream.onAbort(() => gone.abort());
      try {
        await provisionWorkspace(db(), id, emit, { signal: gone.signal });
      } catch (e) {
        // Belt and braces: the run reports its own failures as a terminal event
        // rather than throwing, so nothing is expected to land here.
        await emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  // Files / changed-files for a workspace repo's worktree (right-column views).
  const errorStatus = (e: unknown): 400 | 404 =>
    e instanceof Error && e.message.includes("not found") ? 404 : 400;

  router.get("/:id/repos/:wrId/files", async (c) => {
    try {
      return c.json(await workspaceRepoFiles(db(), c.req.param("wrId")));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, errorStatus(e));
    }
  });

  router.get("/:id/repos/:wrId/changes", async (c) => {
    try {
      return c.json(await workspaceRepoChanges(db(), c.req.param("wrId")));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, errorStatus(e));
    }
  });

  // Push/pull divergence for a workspace repo's branch (header status strip).
  router.get("/:id/repos/:wrId/sync", async (c) => {
    try {
      return c.json(await workspaceRepoSync(db(), c.req.param("wrId")));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, errorStatus(e));
    }
  });

  // Unified diff for a single changed file (opened in a workspace diff tab).
  router.get("/:id/repos/:wrId/diff", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path query parameter is required" }, 400);
    try {
      return c.json(await workspaceRepoFileDiff(db(), c.req.param("wrId"), path));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, errorStatus(e));
    }
  });

  // Link / unlink a task (archiving the workspace completes linked tasks).
  router.post("/:id/tasks", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ taskId: z.string().uuid() }).safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const ok = await linkTask(db(), c.req.param("id"), parsed.data.taskId);
      if (!ok) return c.json({ error: "task not found" }, 404);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  router.delete("/:id/tasks/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    if (!z.string().uuid().safeParse(taskId).success) {
      return c.json({ error: "invalid task id" }, 400);
    }
    try {
      const ok = await unlinkTask(db(), c.req.param("id"), taskId);
      if (!ok) return c.json({ error: "task not found" }, 404);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Link / unlink a GitHub or JIRA issue (archiving the workspace marks it done).
  router.post("/:id/issues", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = linkIssueSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const link = await linkIssue(db(), c.req.param("id"), parsed.data);
      if (!link) return c.json({ error: "workspace not found" }, 404);
      return c.json(link);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // sourceKey ("owner/repo") carries a slash, so the issue is identified by
  // query params rather than path segments.
  router.delete("/:id/issues", async (c) => {
    const parsed = issueRefSchema.safeParse({
      provider: c.req.query("provider"),
      sourceKey: c.req.query("sourceKey"),
      externalId: c.req.query("externalId"),
    });
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const ok = await unlinkIssue(
        db(),
        c.req.param("id"),
        parsed.data.provider,
        parsed.data.sourceKey,
        parsed.data.externalId,
      );
      if (!ok) return c.json({ error: "issue link not found" }, 404);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Starts the archive and returns once the workspace reads `archiving`; the
  // worktree teardown continues in the background so the UI isn't blocked on
  // it. Clients poll GET /:id for the outcome.
  router.post("/:id/archive", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = archiveSchema.safeParse(body ?? {});
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(await startArchiveWorkspace(db(), c.req.param("id"), parsed.data), 202);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  return router;
}
