import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  CredentialRejectedError,
  createEntry,
  deleteEntry,
  listEntries,
  markEntryUsed,
  scanTexts,
  updateEntry,
} from "./service.ts";

/** Cap on stored content: the book is for snippets, not documents. */
const MAX_CONTENT_LENGTH = 8_000;

const createSchema = z.object({
  label: z.string().min(1).max(200),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
  tags: z.array(z.string().max(40)).max(20).optional(),
  pinned: z.boolean().optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  pinned: z.boolean().optional(),
});

const listSchema = z.object({
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const scanSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1), text: z.string() })).max(500),
});

/**
 * Clipboard book routes, mounted under /api/clipboard.
 *
 * `POST /scan` is the odd one out: it stores nothing. Clipboard history lives in
 * memory in the Rust core, and the palette pushes it through here so the
 * credential screen has a single implementation rather than one per process.
 */
export function createClipboardRoutes(config: Config): Hono {
  const router = new Hono();

  const db = () => getDb(config.databaseUrl as string).db;

  // Scanning is pure computation, so it works with no database configured —
  // clipboard history stays screened even before the app is fully set up.
  router.post("/scan", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = scanSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json({ flagged: scanTexts(parsed.data.items) });
  });

  // Every entry route stores or reads rows, so it needs a configured database.
  const requireDb: MiddlewareHandler = async (c, next) =>
    config.databaseUrl ? next() : c.json({ error: "database not configured" }, 503);
  router.use("/entries", requireDb);
  router.use("/entries/*", requireDb);

  router.get("/entries", async (c) => {
    const parsed = listSchema.safeParse({
      query: c.req.query("query"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await listEntries(db(), parsed.data));
  });

  router.post("/entries", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(await createEntry(db(), parsed.data), 201);
    } catch (e) {
      return credentialRefusal(c, e);
    }
  });

  router.patch("/entries/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const entry = await updateEntry(db(), c.req.param("id"), parsed.data);
      if (!entry) return c.json({ error: "not found" }, 404);
      return c.json(entry);
    } catch (e) {
      return credentialRefusal(c, e);
    }
  });

  router.post("/entries/:id/used", async (c) => {
    const entry = await markEntryUsed(db(), c.req.param("id"));
    if (!entry) return c.json({ error: "not found" }, 404);
    return c.json(entry);
  });

  router.delete("/entries/:id", async (c) => {
    const entry = await deleteEntry(db(), c.req.param("id"));
    if (!entry) return c.json({ error: "not found" }, 404);
    return c.json(entry);
  });

  return router;
}

/**
 * Turns a credential refusal into a 422 carrying the matched pattern, so the
 * palette can explain *why* a save was refused instead of showing a bare
 * failure. Anything else rethrows to the app's error handling.
 */
function credentialRefusal(c: Context, e: unknown): Response {
  if (e instanceof CredentialRejectedError) {
    return c.json({ error: e.message, secret: e.finding }, 422);
  }
  throw e;
}
