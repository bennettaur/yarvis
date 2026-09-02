import { Hono } from "hono";
import { z } from "zod";
import { syncBuiltins } from "../agentTools/registry.ts";
import { listRegistryTools, searchRegistry, setToolSettings } from "../agentTools/store.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { UrlSafetyError, validateOutboundUrl } from "../lib/urlSafety.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { getMcpManager } from "./connectionManager.ts";
import {
  beginAuthorization,
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  oauthProviderFor,
  refreshServer,
  revokeAuthorization,
  updateMcpServer,
} from "./service.ts";

/** RFC 7230 token characters, the legal set for HTTP header names. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
/** Reserved header names a server config must not override on outbound requests. */
const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const headerName = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => HEADER_NAME.test(v), "header name must match RFC 7230 token charset")
  .refine(
    (v) => !RESERVED_HEADER_NAMES.has(v.toLowerCase()),
    "header name is reserved and cannot be customised",
  );

const httpUrl = z
  .string()
  .url()
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      validateOutboundUrl(value);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof UrlSafetyError ? e.message : "url is not allowed",
      });
    }
  });

const transport = z.enum(["http", "stdio"]);

/**
 * Space-separated OAuth scope list (RFC 6749 §3.3). Constrained to the printable
 * ASCII the grammar allows so a scope string can't smuggle a newline or a quote
 * into the authorization request.
 */
const oauthScope = z
  .string()
  .max(512)
  .refine((v) => /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(v.trim()), {
    message: "scope must be space-separated printable ASCII tokens",
  });

const createSchema = z
  .object({
    name: z.string().min(1),
    transport,
    // Nullable, not merely optional: the form always sends both fields and
    // nulls the one the chosen transport doesn't use.
    url: httpUrl.nullable().optional(),
    command: z.string().min(1).nullable().optional(),
    args: z.array(z.string()).default([]),
    headerNames: z.array(headerName).default([]),
    oauth: z.boolean().default(false),
    oauthScope: oauthScope.nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.transport === "http" && !v.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "http transport requires a url",
      });
    }
    if (v.transport === "stdio" && !v.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "stdio transport requires a command",
      });
    }
    if (v.oauth && v.transport !== "http") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["oauth"],
        message: "oauth is only available for the http transport",
      });
    }
  });

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  transport: transport.optional(),
  url: httpUrl.nullable().optional(),
  command: z.string().min(1).nullable().optional(),
  args: z.array(z.string()).optional(),
  headerNames: z.array(headerName).optional(),
  oauth: z.boolean().optional(),
  oauthScope: oauthScope.nullable().optional(),
  enabled: z.boolean().optional(),
});

const toolSettingsSchema = z
  .object({
    policy: z.enum(["always", "search", "disabled"]).optional(),
    approval: z.enum(["ask", "auto"]).optional(),
  })
  .refine((v) => v.policy !== undefined || v.approval !== undefined, {
    message: "provide policy, approval, or both",
  });
const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});

/** MCP server + tool registry routes, mounted under /api/mcp. */
export function createMcpRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  // The Tool Manager and search both rely on the built-in tools being present in
  // the registry. Seed them lazily and idempotently (an unchanged resync makes
  // no embedding calls) so the registry is correct even if startup sync hasn't
  // run (e.g. in tests).
  let builtinsSynced = false;
  const ensureBuiltins = async () => {
    if (builtinsSynced) return;
    await syncBuiltins(db(), await chooseEmbedder(config, db()));
    builtinsSynced = true;
  };

  // --- MCP servers -----------------------------------------------------------

  router.get("/servers", async (c) => c.json(await listMcpServers()));

  router.get("/servers/:id", async (c) => {
    const row = await getMcpServer(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  router.post("/servers", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await createMcpServer(parsed.data), 201);
  });

  router.patch("/servers/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const row = await updateMcpServer(c.req.param("id"), parsed.data);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  router.delete("/servers/:id", async (c) => {
    const ok = await deleteMcpServer(db(), c.req.param("id"));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  router.post("/servers/:id/refresh", async (c) => {
    const result = await refreshServer(config, db(), c.req.param("id"));
    if (!result) return c.json({ error: "not found" }, 404);
    return c.json(result);
  });

  router.get("/servers/:id/status", async (c) => {
    const id = c.req.param("id");
    const server = await getMcpServer(id);
    const provider = server ? oauthProviderFor(config, server) : undefined;
    return c.json({
      ...getMcpManager().status(id),
      oauth: provider?.status() ?? null,
    });
  });

  // --- OAuth ------------------------------------------------------------------

  router.post("/servers/:id/authorize", async (c) => {
    try {
      const result = await beginAuthorization(config, db(), c.req.param("id"));
      if (!result) return c.json({ error: "not found, or not an oauth server" }, 404);
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  router.post("/servers/:id/oauth/disconnect", async (c) => {
    const ok = await revokeAuthorization(config, c.req.param("id"));
    if (!ok) return c.json({ error: "not found, or not an oauth server" }, 404);
    return c.json({ ok: true });
  });

  // --- Tool registry ---------------------------------------------------------

  router.get("/tools", async (c) => {
    await ensureBuiltins();
    return c.json(await listRegistryTools(db()));
  });

  router.patch("/tools/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = toolSettingsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const row = await setToolSettings(db(), c.req.param("id"), parsed.data);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  router.post("/tools/search", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = searchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    await ensureBuiltins();
    const hits = await searchRegistry(
      db(),
      await chooseEmbedder(config, db()),
      parsed.data.query,
      parsed.data.limit,
    );
    return c.json(hits);
  });

  return router;
}
