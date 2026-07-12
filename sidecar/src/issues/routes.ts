import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { GitHubClient } from "../github/client.ts";
import { createWorkspace } from "../workspaces/service.ts";
import {
  addStar,
  applyStartWorkSideEffects,
  buildIssuePrompt,
  createFilter,
  deleteFilter,
  findRepoBySourceKey,
  getWorkspaceRoot,
  IN_PROGRESS_LABEL,
  listFilters,
  listIssueRepos,
  listLinks,
  listStars,
  mergeIssues,
  removeStar,
  upsertLink,
  writeIssuePrompt,
} from "./service.ts";
import type { IssueProvider } from "./types.ts";

/**
 * Same owner/repo validation the PR routes use — these params are interpolated
 * into `${owner}/${repo}/...` GitHub API paths, so they must not smuggle extra
 * path segments.
 */
const ownerName = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "invalid github owner");
const repoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "invalid github repo");
const ownerRepoParams = z.object({ owner: ownerName, repo: repoName });

const filterSchema = z.object({
  name: z.string().min(1),
  query: z.string().min(1),
});

const starSchema = z.object({
  sourceKey: z.string().min(1).max(140),
  externalId: z.string().min(1).max(64),
  title: z.string().nullish(),
  url: z.string().nullish(),
});

const startWorkSchema = z.object({
  sourceKey: z.string().min(1).max(140),
  externalId: z.string().min(1).max(64),
  title: z.string().min(1),
  body: z.string().default(""),
  url: z.string().nullish(),
  assignSelf: z.boolean().default(true),
  applyLabel: z.boolean().default(true),
  label: z.string().min(1).max(50).default(IN_PROGRESS_LABEL),
});

const promptFileSchema = z.object({
  workspaceId: z.string().uuid(),
  prompt: z.string().min(1),
});

/** Providers with issue support today. JIRA slots in here later. */
const SUPPORTED_PROVIDERS: IssueProvider[] = ["github"];

/**
 * Ticket-system issue routes, mounted under /api/issues. Source-agnostic:
 * every path is scoped by a `:provider` segment. Only GitHub is wired today;
 * an unknown provider 404s so a future JIRA client is additive.
 */
export function createIssueRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  // Guard the provider segment once, up front.
  router.use("/:provider/*", async (c, next) => {
    const provider = c.req.param("provider");
    if (!SUPPORTED_PROVIDERS.includes(provider as IssueProvider)) {
      return c.json({ error: `unsupported issue provider: ${provider}` }, 404);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;
  const github = () =>
    config.secrets.githubToken ? new GitHubClient(config.secrets.githubToken) : null;

  // --- Configured repos (for grouping + the "all open" scope) ---

  router.get("/:provider/repos", async (c) => {
    const rows = await listIssueRepos(db());
    return c.json(rows.map((r) => ({ id: r.id, owner: r.owner, repo: r.repo, name: r.name })));
  });

  // --- Live issue queries (require a token) ---

  // Open issues assigned to the authenticated user, across configured repos.
  router.get("/:provider/assigned", async (c) => {
    const gh = github();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    try {
      const repos = await listIssueRepos(db());
      if (repos.length === 0) return c.json([]);
      const { login } = await gh.viewer();
      const results = await Promise.allSettled(
        repos.map((r) => gh.listRepoIssues(r.owner, r.repo, { assignee: login })),
      );
      return c.json(mergeIssues(results));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // All open issues across configured repos.
  router.get("/:provider/all", async (c) => {
    const gh = github();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    try {
      const repos = await listIssueRepos(db());
      if (repos.length === 0) return c.json([]);
      const results = await Promise.allSettled(
        repos.map((r) => gh.listRepoIssues(r.owner, r.repo)),
      );
      return c.json(mergeIssues(results));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Free-text search (GitHub search syntax), for saved filters.
  router.get("/:provider/search", async (c) => {
    const gh = github();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const q = c.req.query("q");
    if (!q) return c.json({ error: "missing q" }, 400);
    try {
      return c.json(await gh.searchIssues(q));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  function parseIssueParams(
    owner: string,
    repo: string,
    rawNumber: string,
  ): { owner: string; repo: string; number: number } | { error: unknown } {
    const parsed = ownerRepoParams.safeParse({ owner, repo });
    if (!parsed.success) return { error: parsed.error.flatten() };
    const number = Number(rawNumber);
    if (!Number.isInteger(number) || number < 1) return { error: "bad number" };
    return { owner: parsed.data.owner, repo: parsed.data.repo, number };
  }

  // Rich detail (body + comments) for the issue detail view.
  router.get("/:provider/detail/:owner/:repo/:number", async (c) => {
    const gh = github();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parseIssueParams(
      c.req.param("owner"),
      c.req.param("repo"),
      c.req.param("number"),
    );
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      return c.json(await gh.issueDetail(params.owner, params.repo, params.number));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // --- Saved filters (database only) ---

  router.get("/:provider/filters", async (c) =>
    c.json(await listFilters(db(), c.req.param("provider"))),
  );

  router.post("/:provider/filters", async (c) => {
    const parsed = filterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(
      await createFilter(db(), c.req.param("provider"), parsed.data.name, parsed.data.query),
      201,
    );
  });

  router.delete("/:provider/filters/:id", async (c) =>
    c.json({ deleted: await deleteFilter(db(), c.req.param("id")) }),
  );

  // --- Stars (database only) ---

  router.get("/:provider/stars", async (c) =>
    c.json(await listStars(db(), c.req.param("provider"))),
  );

  router.post("/:provider/stars", async (c) => {
    const parsed = starSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    await addStar(db(), { provider: c.req.param("provider"), ...parsed.data });
    return c.json({ ok: true }, 201);
  });

  router.delete("/:provider/stars", async (c) => {
    const sourceKey = c.req.query("sourceKey");
    const externalId = c.req.query("externalId");
    if (!sourceKey || !externalId) return c.json({ error: "missing sourceKey/externalId" }, 400);
    return c.json({
      deleted: await removeStar(db(), c.req.param("provider"), sourceKey, externalId),
    });
  });

  // --- Workspace links + local status (database only) ---

  router.get("/:provider/links", async (c) =>
    c.json(await listLinks(db(), c.req.param("provider"))),
  );

  // --- Start work: open a workspace for an issue ---

  /**
   * Creates a workspace for an issue, links it (local status → in_progress), and
   * — best-effort — assigns the issue to the viewer and labels it in-progress on
   * GitHub. The workspace + link are the source of truth: a failed GitHub write
   * (e.g. a read-only token) is reported as a warning, not an error, so work
   * still starts. The response carries the composed Claude prompt; provisioning
   * and prompt-file writing happen next via the workspace provision route and
   * `/prompt-file` (the worktree doesn't exist yet here).
   */
  router.post("/:provider/start-work", async (c) => {
    const provider = c.req.param("provider");
    const parsed = startWorkSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const input = parsed.data;

    const number = Number(input.externalId);
    if (!Number.isInteger(number) || number < 1) return c.json({ error: "bad issue id" }, 400);

    const repo = await findRepoBySourceKey(db(), input.sourceKey);
    if (!repo) {
      return c.json({ error: `repo ${input.sourceKey} is not registered` }, 400);
    }

    let workspaceId: string;
    try {
      const ws = await createWorkspace(db(), config, { name: input.title, repoIds: [repo.id] });
      workspaceId = ws.id;
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    await upsertLink(db(), {
      provider,
      sourceKey: input.sourceKey,
      externalId: input.externalId,
      title: input.title,
      url: input.url ?? null,
      workspaceId,
      localStatus: "in_progress",
    });

    // Best-effort GitHub side effects (assign + label). Failures degrade to
    // warnings — the workspace + link already succeeded.
    const gh = github();
    const warnings = gh
      ? await applyStartWorkSideEffects(gh, repo.owner, repo.repo, number, {
          assignSelf: input.assignSelf,
          applyLabel: input.applyLabel,
          label: input.label,
        })
      : [];

    const prompt = buildIssuePrompt({
      displayId: `#${number}`,
      title: input.title,
      url: input.url ?? null,
      body: input.body,
      sourceKey: input.sourceKey,
    });

    return c.json({ workspaceId, prompt, warnings }, 201);
  });

  /**
   * Writes the issue prompt into a provisioned workspace and returns its
   * absolute path. Called after provisioning completes (the worktrees, and thus
   * the workspace root, exist by then); the terminal then launches Claude with
   * this file.
   */
  router.post("/:provider/prompt-file", async (c) => {
    const parsed = promptFileSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const root = await getWorkspaceRoot(db(), parsed.data.workspaceId);
    if (!root) return c.json({ error: "workspace not found" }, 404);
    try {
      const path = await writeIssuePrompt(root, parsed.data.prompt);
      return c.json({ path });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  return router;
}
