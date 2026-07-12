import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  archiveWorkspace,
  createRepo,
  createWorkspace,
  deleteRepo,
  findWorkspaceForPr,
  getRepo,
  getWorkspace,
  linkTask,
  listRepos,
  listWorkspaces,
  type ProvisionEvent,
  provisionWorkspace,
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
  taskId: z.string().uuid().nullish(),
});

const archiveSchema = z.object({
  summary: z.string().nullish(),
  mergedPrUrl: z.string().nullish(),
  force: z.boolean().optional(),
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

  // The active workspace (if any) a GitHub PR was raised from, so the PR view
  // can link back to it. Registered before "/:id" so "for-pr" isn't read as an
  // id. Returns null (200) when there's no match.
  router.get("/for-pr", async (c) => {
    const owner = c.req.query("owner");
    const repo = c.req.query("repo");
    const number = Number(c.req.query("number"));
    if (!owner || !repo || !Number.isInteger(number)) {
      return c.json({ error: "owner, repo, and number are required" }, 400);
    }
    return c.json(await findWorkspaceForPr(db(), owner, repo, number));
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

  // Drives provisioning and streams progress as SSE. The setup script's output
  // arrives as `log` events; the stream ends with a `done` event.
  router.post("/:id/provision", async (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const emit = (event: ProvisionEvent) => stream.writeSSE({ data: JSON.stringify(event) });
      try {
        await provisionWorkspace(db(), id, emit);
      } catch (e) {
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

  router.post("/:id/archive", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = archiveSchema.safeParse(body ?? {});
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(await archiveWorkspace(db(), c.req.param("id"), parsed.data));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  return router;
}
