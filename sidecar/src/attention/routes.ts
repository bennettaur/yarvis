import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { readSessionActivityById } from "../cc/sessions.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { type AttentionNavTarget, workspaces } from "../db/schema.ts";
import { type AttentionStreamEvent, publish, subscribe } from "./hub.ts";
import {
  awaitPermissionDecision,
  canHoldAnotherPermission,
  decidePermission,
  hasPendingPermission,
  hookOutputFor,
  listPendingPermissions,
  type PermissionDecision,
  type PermissionRequestInfo,
  summarizePermission,
  truncate,
} from "./permissions.ts";
import {
  type AttentionKind,
  type AttentionStatus,
  clearAttentionScope,
  createAttention,
  listAttention,
  resolvePermissionItems,
  updateAttentionStatus,
} from "./service.ts";

const KIND = z.enum(["permission", "idle", "completed", "error", "info"]);

/**
 * A workspace id lands in a `uuid` column, so a non-uuid would surface as an
 * unhandled 500 from Postgres rather than a 400. Matched by shape rather than
 * with zod's `.uuid()`, which additionally enforces RFC version/variant bits
 * that Postgres itself does not.
 */
const UUID = z
  .string()
  .regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/, "must be a uuid");

/** Bounds what a token holder can persist per item (stored twice: column + payload). */
const MAX_SESSION_KEY = 256;

/** Cap on a single stream's pending-write queue, so a stalled reader is bounded. */
const MAX_STREAM_QUEUE = 256;

/**
 * Body a Claude Code hook posts. The values baked into the per-workspace
 * `.claude/settings.json` command are safe literals (a uuid, a fixed kind); the
 * session key comes from the PTY's `YARVIS_SESSION_KEY`, which the core sets to
 * the session's own id — so an item points at the exact terminal tab that raised
 * it. `workspaceId` is absent for a session outside any workspace (the
 * standalone Terminal tab). The display title is looked up from the workspace.
 */
export const ingestSchema = z.object({
  workspaceId: UUID.optional(),
  sessionKey: z.string().min(1).max(MAX_SESSION_KEY),
  kind: KIND,
  hookEvent: z.string().max(64).optional(),
});

/**
 * How long the ingest route holds a permission request open waiting for the
 * user. Kept under Bun's 255s idle timeout (`server.ts`), which would otherwise
 * close the silent connection first. The hook's own `timeout` in
 * `claudeSettings.ts` sits just above this.
 */
export const PERMISSION_HOLD_MS = 240_000;

/**
 * Largest hook body accepted. A Write's input carries the whole file, so this
 * is generous, but it stops a token holder parking huge bodies in memory.
 */
const MAX_PERMISSION_BODY_BYTES = 2 * 1024 * 1024;

/** Caps on what a reply or prompt pulled from the transcript adds to the request. */
const MAX_CONTEXT_CHARS = 2_000;

/**
 * The stdin Claude Code gives a `PermissionRequest` hook, which the hook posts
 * as-is. Only the fields the app shows are read; the rest are ignored.
 */
export const permissionHookSchema = z.object({
  session_id: z.string().max(256).optional(),
  cwd: z.string().max(4096).optional(),
  permission_mode: z.string().max(64).optional(),
  tool_name: z.string().min(1).max(256),
  tool_input: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Who is asking. The hook can't put these in the body, which is Claude Code's
 * stdin, so it sends them as headers with the same values the attention hook
 * bakes in.
 */
const permissionOriginSchema = z.object({
  workspaceId: UUID.optional(),
  sessionKey: z.string().min(1).max(MAX_SESSION_KEY),
});

const clip = (text: string | undefined | null) => (text ? truncate(text, MAX_CONTEXT_CHARS) : null);

/** A human summary for each kind, used when the hook carries no message. */
function defaultBody(kind: AttentionKind): string {
  switch (kind) {
    case "permission":
      return "Needs permission to continue";
    case "idle":
      return "Waiting for your input";
    case "completed":
      return "Finished — ready for you";
    case "error":
      return "Hit an error";
    case "info":
      return "Wants your attention";
  }
}

/**
 * Where clicking the item lands. A workspace's pinned Claude session keeps the
 * `workspace-claude` target (the frontend already knows how to focus that tab);
 * anything else is a specific terminal session, so we address the tab directly
 * and carry the workspace along when there is one.
 */
function navTargetFor(sessionKey: string, workspaceId?: string): AttentionNavTarget {
  if (workspaceId && sessionKey === `ws-claude:${workspaceId}`) {
    return { type: "workspace-claude", workspaceId };
  }
  return { type: "terminal", sessionKey, ...(workspaceId ? { workspaceId } : {}) };
}

/**
 * Attention-ingest, mounted at `/ingest` OUTSIDE the main bearer wall. Its own
 * middleware accepts only the scoped attention token, and it can only create
 * attention items and put permission prompts in front of the user — so a Claude
 * session shell holding that token can raise a flag, or ask, without gaining
 * access to the rest of the API. Answering a prompt needs the main bearer.
 */
export function createAttentionIngestRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", bearerAuth({ token: config.attentionToken }));

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  /**
   * Raises (or refreshes) the session's permission item to show this request.
   * A failure to store it is logged and never blocks the request itself.
   */
  const raisePermissionItem = (info: PermissionRequestInfo): Promise<void> => {
    const summary = summarizePermission(info.toolName, info.toolInput);
    return createAttention(db(), {
      source: "claude-hook",
      sessionKey: info.sessionKey,
      workspaceId: info.workspaceId,
      kind: "permission",
      title: info.workspaceName ?? "Claude session",
      body: summary,
      navTarget: navTargetFor(info.sessionKey, info.workspaceId ?? undefined),
      payload: { requestId: info.id, toolName: info.toolName },
    })
      .then(publish)
      .catch((e) => {
        console.error("[attention] could not raise a permission item:", e?.message ?? e);
      });
  };

  router.post("/attention", async (c) => {
    const parsed = ingestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { workspaceId, sessionKey, kind } = parsed.data;

    const [ws] = workspaceId
      ? await db()
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
      : [];

    const item = await createAttention(db(), {
      source: "claude-hook",
      sessionKey,
      workspaceId: workspaceId ?? null,
      kind,
      title: ws?.name ?? "Claude session",
      body: defaultBody(kind),
      navTarget: navTargetFor(sessionKey, workspaceId),
      payload: parsed.data,
    });
    publish(item);
    return c.json({ id: item.id }, 201);
  });

  // Holds the hook's connection until the user answers in the app. The reply
  // is the hook's stdout: a decision, or an empty body to leave the prompt to
  // Claude Code's own dialog.
  router.post(
    "/permission",
    // A refusal prints nothing from the hook, so Claude Code shows its own dialog.
    bodyLimit({ maxSize: MAX_PERMISSION_BODY_BYTES, onError: (c) => c.body(null, 413) }),
    async (c) => {
      const arrivedAt = Date.now();
      if (!canHoldAnotherPermission()) return c.body(null, 204);
      const origin = permissionOriginSchema.safeParse({
        workspaceId: c.req.header("x-yarvis-workspace-id") || undefined,
        sessionKey: c.req.header("x-yarvis-session-key"),
      });
      if (!origin.success) return c.json({ error: origin.error.flatten() }, 400);
      const parsed = permissionHookSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
      const { workspaceId, sessionKey } = origin.data;
      const hook = parsed.data;

      const [ws] = workspaceId
        ? await db()
            .select({ name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
        : [];

      // What the agent said just before asking is the best answer to "why does it
      // want this". Missing context never blocks the request.
      const activity =
        hook.cwd && hook.session_id
          ? await readSessionActivityById(hook.cwd, hook.session_id, 1).catch(() => null)
          : null;

      let raised: Promise<void> = Promise.resolve();

      const decision = await awaitPermissionDecision(
        {
          sessionKey,
          workspaceId: workspaceId ?? null,
          workspaceName: ws?.name ?? null,
          toolName: hook.tool_name,
          toolInput: hook.tool_input,
          cwd: hook.cwd ?? null,
          permissionMode: hook.permission_mode ?? null,
          lastReply: clip(activity?.lastReply?.text),
          lastPrompt: clip(activity?.prompts.at(-1)?.text),
        },
        {
          // Counted from arrival, so the lookups above can't push the reply
          // past curl's own deadline.
          timeoutMs: PERMISSION_HOLD_MS - (Date.now() - arrivedAt),
          signal: c.req.raw.signal,
          onRegistered: (info) => {
            raised = raisePermissionItem(info);
          },
        },
      );

      // Answered, or the hook ended (Claude Code killed it), means this request
      // no longer blocks anyone. A timeout or a hand-back leaves the terminal
      // dialog waiting, so the item stays for the user to follow.
      const handled = decision !== null && decision.behavior !== "terminal";
      const hookGone = decision === null && c.req.raw.signal.aborted;
      // The item may still be on its way in; resolving first would leave it pending.
      await raised;
      if ((handled || hookGone) && !hasPendingPermission(sessionKey)) {
        const rows = await resolvePermissionItems(db(), sessionKey).catch(() => []);
        for (const row of rows) publish(row);
        // Another request from the session may have arrived while that ran;
        // raise its item again so it isn't lost.
        const next = listPendingPermissions({ sessionKey }).at(-1);
        if (next) await raisePermissionItem(next);
      }

      const output = hookOutputFor(decision);
      return output ? c.json(output) : c.body(null, 204);
    },
  );

  return router;
}

const decisionSchema = z.discriminatedUnion("behavior", [
  z.object({ behavior: z.literal("allow") }),
  z.object({ behavior: z.literal("deny"), message: z.string().trim().max(4_000).optional() }),
  z.object({ behavior: z.literal("terminal") }),
]);

const patchSchema = z.object({
  status: z.enum(["read", "resolved", "dismissed"]),
});

/**
 * Exactly one scope field. An empty scope would clear the whole stream, and
 * accepting both would leave "clear session S *and* workspace W" reading as an
 * intersection while the query does a union — so neither is allowed in.
 */
const clearSchema = z
  .object({
    sessionKey: z.string().min(1).max(MAX_SESSION_KEY).optional(),
    workspaceId: UUID.optional(),
    status: z.enum(["read", "resolved", "dismissed"]),
  })
  .refine((v) => Boolean(v.sessionKey) !== Boolean(v.workspaceId), {
    message: "exactly one of sessionKey or workspaceId is required",
  });

/** Heartbeat interval so proxies/keep-alive don't drop an idle stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Read + mutate routes for the webview, mounted under `/api/attention` behind the
 * main bearer. `GET /` hydrates the current list, `GET /stream` delivers live
 * deltas over SSE, `PATCH /:id` moves an item through its lifecycle, and
 * `POST /clear` does the same for every pending item in a scope.
 */
export function createAttentionRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  const parseStatus = (value: string | undefined): AttentionStatus | undefined =>
    value === "pending" || value === "read" || value === "resolved" || value === "dismissed"
      ? value
      : undefined;

  // Supports ?status=<status>. Newest-first.
  router.get("/", async (c) => {
    const items = await listAttention(db(), { status: parseStatus(c.req.query("status")) });
    return c.json(items);
  });

  // Live stream: forwards each item as it is published. A client that misses
  // events while disconnected recovers by re-hydrating from `GET /` on reconnect,
  // so the stream itself is purely forward — no replay/backfill.
  router.get("/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      // Bridge published rows into this stream via a bounded queue drained below.
      // The cap drops the oldest if a client stops reading, so a stalled consumer
      // can't grow this without limit.
      const queue: AttentionStreamEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = subscribe((item) => {
        queue.push({ type: "item", item });
        if (queue.length > MAX_STREAM_QUEUE) queue.shift();
        wake?.();
      });

      const signal = c.req.raw.signal;

      // Resolves true when a new item is queued, false on heartbeat timeout or
      // abort. Cleans up its own timer + listener so nothing dangles.
      const waitForItemOrHeartbeat = () =>
        new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            wake = null;
            resolve(value);
          };
          const timer = setTimeout(() => finish(false), HEARTBEAT_MS);
          const onAbort = () => finish(false);
          signal.addEventListener("abort", onAbort, { once: true });
          wake = () => finish(true);
        });

      try {
        while (!signal.aborted) {
          while (queue.length > 0) {
            await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
          }
          if (signal.aborted) break;
          const gotItem = await waitForItemOrHeartbeat();
          if (signal.aborted) break;
          if (!gotItem) {
            await stream.writeSSE({ data: JSON.stringify({ type: "ping" }) });
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  // Clears a whole scope at once — viewing a workspace (or the tab that raised
  // the flag) shouldn't cost one request per item.
  router.post("/clear", async (c) => {
    const parsed = clearSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { status, ...scope } = parsed.data;
    const rows = await clearAttentionScope(db(), scope, status);
    for (const row of rows) publish(row);
    return c.json(rows);
  });

  // Permission requests still waiting on this sidecar, optionally for one session.
  router.get("/permissions", (c) =>
    c.json(listPendingPermissions({ sessionKey: c.req.query("sessionKey") || undefined })),
  );

  router.post("/permissions/:id", async (c) => {
    const parsed = decisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const decision: PermissionDecision = parsed.data;
    if (!decidePermission(c.req.param("id"), decision)) {
      return c.json({ error: "no longer waiting" }, 410);
    }
    return c.json({ ok: true });
  });

  router.patch("/:id", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const row = await updateAttentionStatus(db(), c.req.param("id"), parsed.data.status);
    if (!row) return c.json({ error: "not found" }, 404);
    publish(row);
    return c.json(row);
  });

  return router;
}
