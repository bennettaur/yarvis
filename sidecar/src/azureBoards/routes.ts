import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { isAllowedAzureOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { emitEvent } from "../events/service.ts";
import { buildIssuePrompt, upsertLink } from "../issues/service.ts";
import { createWorkspace, startKickOff } from "../workspaces/service.ts";
import { AzureBoardsClient } from "./client.ts";
import { applyBoardsStartWorkSideEffects } from "./service.ts";

/**
 * Azure Boards work item routes, mounted under /api/azure-boards. They use the
 * Azure DevOps PAT and org URL the PR dashboard already has. As with JIRA, the
 * provider-neutral slices (stars, saved filters, workspace links) go through
 * `/api/issues/azure`; the live queries and edits live here.
 */

// Work item ids are positive integers. Parsed from the path, so the cap keeps a
// long digit string from turning into an imprecise number.
const workItemId = z.coerce.number().int().positive().max(2_147_483_647);

// Azure project names can't contain `/`, `\` or control characters, and `..`
// would traverse once interpolated into an API path. The name also lands in
// the agent's brief, so a newline must not get through.
const projectName = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (s) =>
      ![...s].some((ch) => ch < " " || ch === "\x7f" || ch === "/" || ch === "\\") &&
      !s.includes(".."),
    "invalid project",
  );

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(32_000).optional(),
    reproSteps: z.string().max(32_000).optional(),
    // Azure stores tags as one `;`-separated string, so a `;` would split a tag.
    tags: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(400)
          .refine((t) => !t.includes(";"), "tags can't contain ;"),
      )
      .max(50)
      .optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), "no fields to update");

const stateSchema = z.object({ state: z.string().trim().min(1).max(128) });

// Only "assign to me" and "unassign". Assigning someone else is done in Azure.
const assigneeSchema = z.object({ self: z.boolean() });

const commentSchema = z.object({ body: z.string().trim().min(1).max(32_000) });

const startWorkSchema = z.object({
  sourceKey: projectName,
  // A string here because it's the shared issue-link key; the same rule as a path id.
  externalId: z
    .string()
    .refine((s) => workItemId.safeParse(s).success && /^\d+$/.test(s), "invalid work item id"),
  title: z.string().min(1),
  body: z.string().default(""),
  url: z.string().nullish(),
  // Repos to build the workspace from. Empty is allowed and gives a scratch workspace.
  repoIds: z.array(z.string().uuid()).default([]),
  assignSelf: z.boolean().default(true),
  moveToInProgress: z.boolean().default(true),
  // A state chosen in the Start Work dialog; falls back to the in-progress
  // heuristic when omitted.
  state: z.string().min(1).max(128).optional(),
});

/** Most ids one `/items` request may ask for; the starred list is the caller. */
const MAX_ITEM_IDS = 200;

export function createAzureBoardsRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  type ClientGate =
    | { ok: true; client: AzureBoardsClient }
    | { ok: false; reason: "missing_token" | "missing_org_url" | "invalid_org_url" };

  const gateClient = (): ClientGate => {
    const { azureDevopsToken, azureDevopsOrgUrl } = config.secrets;
    if (!azureDevopsToken) return { ok: false, reason: "missing_token" };
    if (!azureDevopsOrgUrl) return { ok: false, reason: "missing_org_url" };
    // The PAT is sent to this host on every request, so it must be Azure's.
    if (!isAllowedAzureOrgUrl(azureDevopsOrgUrl)) return { ok: false, reason: "invalid_org_url" };
    return { ok: true, client: new AzureBoardsClient(azureDevopsToken, azureDevopsOrgUrl) };
  };

  /** Resolves the client or returns a 400 naming which setting to fix. */
  const requireClient = (c: Context): AzureBoardsClient | Response => {
    const gate = gateClient();
    if (gate.ok) return gate.client;
    if (gate.reason === "invalid_org_url") {
      console.warn(`[azure-boards] invalid org URL: ${config.secrets.azureDevopsOrgUrl}`);
    }
    return c.json({ error: "azure boards not configured", reason: gate.reason }, 400);
  };

  /** Logs the upstream failure in full and returns a sanitized 502. */
  const upstreamError = (c: Context, e: unknown): Response => {
    console.warn(`[azure-boards] upstream error: ${e instanceof Error ? e.message : String(e)}`);
    return c.json({ error: "azure boards request failed" }, 502);
  };

  const parseId = (c: Context): number | Response => {
    const parsed = workItemId.safeParse(c.req.param("id"));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return parsed.data;
  };

  // --- Identity (also the "is Azure Boards configured and working" probe) ---

  router.get("/viewer", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    try {
      return c.json(await client.viewer());
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

  // `wiql` runs a full WIQL query; `text` searches open items by title.
  router.get("/search", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const wiql = c.req.query("wiql");
    const text = c.req.query("text");
    if (!wiql && !text) return c.json({ error: "missing wiql or text" }, 400);
    if ((wiql ?? text ?? "").length > 2000) return c.json({ error: "query too long" }, 400);
    try {
      return c.json(wiql ? await client.queryWiql(wiql) : await client.searchTitle(text ?? ""));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // Work items by id, e.g. `?ids=12,34`. Backs the starred list.
  router.get("/items", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const raw = (c.req.query("ids") ?? "").split(",").filter(Boolean);
    const parsed = z.array(workItemId).max(MAX_ITEM_IDS).safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    if (parsed.data.length === 0) return c.json([]);
    try {
      return c.json(await client.workItems(parsed.data));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // --- Single work item: detail + edits ---

  router.get("/item/:id", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const id = parseId(c);
    if (id instanceof Response) return id;
    try {
      return c.json(await client.workItemDetail(id));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.patch("/item/:id", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const id = parseId(c);
    if (id instanceof Response) return id;
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await client.updateFields(id, parsed.data);
      void emitEvent(db(), {
        type: "azure_boards.item.updated",
        source: "azure_boards",
        payload: { id, fields: Object.keys(parsed.data) },
      });
      return c.json(await client.workItemDetail(id));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.post("/item/:id/state", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const id = parseId(c);
    if (id instanceof Response) return id;
    const parsed = stateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await client.setState(id, parsed.data.state);
      void emitEvent(db(), {
        type: "azure_boards.item.updated",
        source: "azure_boards",
        payload: { id, state: parsed.data.state },
      });
      return c.json(await client.workItemDetail(id));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.put("/item/:id/assignee", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const id = parseId(c);
    if (id instanceof Response) return id;
    const parsed = assigneeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const uniqueName = parsed.data.self ? (await client.viewer()).uniqueName : null;
      await client.assign(id, uniqueName);
      return c.json(await client.workItemDetail(id));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.post("/item/:id/comment", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const id = parseId(c);
    if (id instanceof Response) return id;
    const parsed = commentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const comment = await client.addComment(id, parsed.data.body);
      void emitEvent(db(), {
        type: "azure_boards.item.commented",
        source: "azure_boards",
        payload: { id },
      });
      return c.json(comment, 201);
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // --- Start work: open a workspace for a work item ---

  /**
   * Creates a workspace for a work item and links it, the same way JIRA's
   * start-work does: the caller picks the repos (none gives a scratch
   * workspace), assigning and moving the item are best-effort warnings, and the
   * kick-off runs in the background here.
   */
  router.post("/start-work", async (c) => {
    const client = requireClient(c);
    if (client instanceof Response) return client;
    const parsed = startWorkSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const input = parsed.data;

    const prompt = buildIssuePrompt({
      displayId: `#${input.externalId}`,
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
        brief: prompt,
      });
      workspaceId = ws.id;
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    await upsertLink(db(), {
      provider: "azure",
      sourceKey: input.sourceKey,
      externalId: input.externalId,
      title: input.title,
      url: input.url ?? null,
      workspaceId,
      localStatus: "in_progress",
    });

    const warnings = await applyBoardsStartWorkSideEffects(client, Number(input.externalId), {
      assignSelf: input.assignSelf,
      moveToInProgress: input.moveToInProgress,
      state: input.state,
    });

    startKickOff(db(), workspaceId);

    void emitEvent(db(), {
      type: "azure_boards.work_started",
      source: "azure_boards",
      payload: { id: input.externalId, workspaceId, repos: input.repoIds.length },
    });

    return c.json({ workspaceId, warnings }, 201);
  });

  return router;
}
