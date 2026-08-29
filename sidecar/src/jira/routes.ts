import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { emitEvent } from "../events/service.ts";
import { buildIssuePrompt, upsertLink } from "../issues/service.ts";
import { createWorkspace, startKickOff } from "../workspaces/service.ts";
import { isAllowedJiraBaseUrl, JiraClient } from "./client.ts";
import { applyJiraStartWorkSideEffects } from "./service.ts";

/**
 * JIRA issue routes, mounted under /api/jira. Unlike GitHub, a JIRA issue is
 * addressed by its key ("PROJ-45"), not owner/repo/number, and carries workflow
 * transitions and editable fields — so its live queries and mutations live here
 * rather than under the shared `/api/issues/:provider` routes (which JIRA still
 * reuses for the provider-neutral stars / saved filters / workspace links).
 */

// Project key + number, e.g. "PROJ-45". Interpolated into JIRA API paths, so it
// must not smuggle extra path segments. Case-insensitive; JIRA keys are upper.
const issueKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/, "invalid jira issue key");

const projectKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "invalid jira project key");

const updateSchema = z
  .object({
    summary: z.string().min(1).max(255).optional(),
    description: z.string().max(32_000).optional(),
    labels: z.array(z.string().min(1).max(255)).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "no fields to update");

const transitionSchema = z.object({ transitionId: z.string().min(1).max(64) });

const assigneeSchema = z.object({ accountId: z.string().min(1).max(128).nullable() });

const commentSchema = z.object({ body: z.string().min(1).max(32_000) });

const createSchema = z.object({
  projectKey,
  summary: z.string().min(1).max(255),
  description: z.string().max(32_000).optional(),
  issueTypeName: z.string().min(1).max(100),
});

const startWorkSchema = z.object({
  sourceKey: projectKey,
  externalId: issueKey,
  title: z.string().min(1),
  body: z.string().default(""),
  url: z.string().nullish(),
  // Repos to build the workspace from. Empty is allowed → a scratch workspace.
  repoIds: z.array(z.string().uuid()).default([]),
  assignSelf: z.boolean().default(true),
  transitionToInProgress: z.boolean().default(true),
  // Explicit target transition chosen in the Start Work dialog; falls back to
  // the in-progress heuristic when omitted.
  transitionId: z.string().min(1).max(64).optional(),
});

export function createJiraRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  type ClientGate =
    | { ok: true; client: JiraClient }
    | {
        ok: false;
        reason: "missing_base_url" | "missing_email" | "missing_token" | "invalid_base_url";
      };

  const gateClient = (): ClientGate => {
    const { jiraBaseUrl, jiraEmail, jiraApiToken } = config.secrets;
    if (!jiraBaseUrl) return { ok: false, reason: "missing_base_url" };
    if (!jiraEmail) return { ok: false, reason: "missing_email" };
    if (!jiraApiToken) return { ok: false, reason: "missing_token" };
    // A malformed or non-atlassian.net base URL is rejected so the API token is
    // never sent to an unexpected host.
    if (!isAllowedJiraBaseUrl(jiraBaseUrl)) return { ok: false, reason: "invalid_base_url" };
    return { ok: true, client: new JiraClient(jiraBaseUrl, jiraEmail, jiraApiToken) };
  };

  /** Resolves the JIRA client or returns a 400 naming which secret to fix. */
  const requireClient = (c: Context): JiraClient | Response => {
    const gate = gateClient();
    if (gate.ok) return gate.client;
    if (gate.reason === "invalid_base_url") {
      console.warn(`[jira] invalid base URL: ${config.secrets.jiraBaseUrl}`);
    }
    return c.json({ error: "jira not configured", reason: gate.reason }, 400);
  };

  /** Logs the upstream failure in full and returns a sanitized 502. */
  const upstreamError = (c: Context, e: unknown): Response => {
    console.warn(`[jira] upstream error: ${e instanceof Error ? e.message : String(e)}`);
    return c.json({ error: "jira request failed" }, 502);
  };

  // --- Identity (also the "is JIRA configured & working" probe) ---

  router.get("/viewer", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    try {
      return c.json(await client.myself());
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // --- Live queries ---

  router.get("/assigned", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    try {
      return c.json(await client.assignedToMe());
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.get("/created", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    try {
      return c.json(await client.createdByMe());
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // Free-form JQL search (also backs saved filters).
  router.get("/search", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const jql = c.req.query("jql");
    if (!jql) return c.json({ error: "missing jql" }, 400);
    // Bound the query length, consistent with the body-field caps elsewhere.
    if (jql.length > 2000) return c.json({ error: "jql too long" }, 400);
    try {
      return c.json(await client.searchIssues(jql));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // --- Single issue: detail + mutations ---

  const parseKey = (c: Context): string | Response => {
    const parsed = issueKey.safeParse(c.req.param("key"));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return parsed.data;
  };

  router.get("/issue/:key", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const key = parseKey(c);
    if (key instanceof Response) return key;
    try {
      return c.json(await client.issueDetail(key));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.patch("/issue/:key", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const key = parseKey(c);
    if (key instanceof Response) return key;
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await client.updateFields(key, parsed.data);
      void emitEvent(db(), {
        type: "jira.issue.updated",
        source: "jira",
        payload: { key, fields: Object.keys(parsed.data) },
      });
      return c.json(await client.issueDetail(key));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.post("/issue/:key/transition", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const key = parseKey(c);
    if (key instanceof Response) return key;
    const parsed = transitionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await client.transitionIssue(key, parsed.data.transitionId);
      void emitEvent(db(), {
        type: "jira.issue.updated",
        source: "jira",
        payload: { key, transitioned: true },
      });
      return c.json(await client.issueDetail(key));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.put("/issue/:key/assignee", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const key = parseKey(c);
    if (key instanceof Response) return key;
    const parsed = assigneeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await client.assign(key, parsed.data.accountId);
      return c.json(await client.issueDetail(key));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.post("/issue/:key/comment", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const key = parseKey(c);
    if (key instanceof Response) return key;
    const parsed = commentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const comment = await client.addComment(key, parsed.data.body);
      void emitEvent(db(), { type: "jira.issue.commented", source: "jira", payload: { key } });
      return c.json(comment, 201);
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.get("/issue/:key/assignable", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const key = parseKey(c);
    if (key instanceof Response) return key;
    try {
      return c.json(await client.searchAssignableUsers(key, c.req.query("query") ?? ""));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // --- Create issue + metadata ---

  router.get("/projects", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    try {
      return c.json(await client.listProjects());
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.get("/projects/:key/issue-types", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const parsed = projectKey.safeParse(c.req.param("key"));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(await client.projectIssueTypes(parsed.data));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.post("/issues", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const created = await client.createIssue(parsed.data);
      void emitEvent(db(), {
        type: "jira.issue.created",
        source: "jira",
        payload: { key: created.externalId, projectKey: parsed.data.projectKey },
      });
      return c.json(created, 201);
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // --- Start work: open a workspace for an issue ---

  /**
   * Creates a workspace for a JIRA issue and links it (local status →
   * in_progress). Because a JIRA ticket isn't tied to a repo, the caller chooses
   * the repos (an empty list yields a scratch workspace). Best-effort JIRA side
   * effects (assign to viewer + transition to in-progress) become warnings on
   * failure — the workspace + link are the source of truth. The rest of the
   * kick-off — provisioning, seeding `.yarvis/issue-prompt.md`, launching the
   * agent on the ticket — runs in the background here, so nothing about it
   * depends on the caller sticking around.
   */
  router.post("/start-work", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const parsed = startWorkSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const input = parsed.data;

    const prompt = buildIssuePrompt({
      displayId: input.externalId,
      title: input.title,
      url: input.url ?? null,
      body: input.body,
      sourceKey: input.sourceKey,
    });

    let workspaceId: string;
    try {
      const ws = await createWorkspace(db(), config, {
        name: input.title,
        repoIds: input.repoIds,
        issuePrompt: prompt,
      });
      workspaceId = ws.id;
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    await upsertLink(db(), {
      provider: "jira",
      sourceKey: input.sourceKey,
      externalId: input.externalId,
      title: input.title,
      url: input.url ?? null,
      workspaceId,
      localStatus: "in_progress",
    });

    const warnings = await applyJiraStartWorkSideEffects(client, input.externalId, {
      assignSelf: input.assignSelf,
      transitionToInProgress: input.transitionToInProgress,
      transitionId: input.transitionId,
    });

    startKickOff(db(), workspaceId);

    void emitEvent(db(), {
      type: "jira.work_started",
      source: "jira",
      payload: { key: input.externalId, workspaceId, repos: input.repoIds.length },
    });

    return c.json({ workspaceId, warnings }, 201);
  });

  return router;
}
