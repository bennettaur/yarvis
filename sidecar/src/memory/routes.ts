import { generateText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { resolveModel } from "../llm/providers.ts";
import { tasksCompletedBetween } from "../tasks/service.ts";
import { chooseEmbedder } from "./embedder.ts";
import { PgVectorMemoryStore } from "./index.ts";
import { fetchUrlText, ingestDocument } from "./ingest.ts";
import {
  assembleRecapContext,
  dateRange,
  recapMaterial,
  recapSystemPrompt,
} from "./recap.ts";

/** Cap the recap LLM call so a hung provider can't block the request forever. */
const RECAP_TIMEOUT_MS = 30_000;

const addSchema = z.object({
  content: z.string().min(1),
  type: z.string().min(1).optional(),
});

const ingestSchema = z
  .object({
    url: z.string().url().optional(),
    text: z.string().min(1).optional(),
    title: z.string().optional(),
  })
  .refine((v) => v.url || v.text, {
    message: "provide either url or text",
  });

const recapSchema = z.object({
  range: z.enum(["day", "week"]),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

/** Memory & knowledge routes, mounted under /api/memory. */
export function createMemoryRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const store = () => {
    const db = getDb(config.databaseUrl as string).db;
    return new PgVectorMemoryStore(db, chooseEmbedder(config));
  };

  router.get("/", async (c) => {
    const type = c.req.query("type") ?? undefined;
    const limit = Number(c.req.query("limit") ?? "100");
    const records = await store().list({
      type,
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return c.json(records);
  });

  router.get("/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "missing q" }, 400);
    const limit = Number(c.req.query("limit") ?? "10");
    return c.json(await store().search(q, Number.isFinite(limit) ? limit : 10));
  });

  router.post("/", async (c) => {
    const parsed = addSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const metadata = parsed.data.type ? { type: parsed.data.type } : undefined;
    return c.json(await store().add(parsed.data.content, metadata), 201);
  });

  // A note is just a memory tagged type "note"; convenience endpoint.
  router.post("/notes", async (c) => {
    const parsed = addSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await store().add(parsed.data.content, { type: "note" }), 201);
  });

  router.delete("/:id", async (c) =>
    c.json({ deleted: await store().delete(c.req.param("id")) }),
  );

  router.post("/ingest", async (c) => {
    const parsed = ingestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      let text = parsed.data.text ?? "";
      let title = parsed.data.title ?? "";
      let source = parsed.data.title ?? "pasted text";
      if (parsed.data.url) {
        const fetched = await fetchUrlText(parsed.data.url);
        text = fetched.text;
        title = parsed.data.title ?? fetched.title;
        source = parsed.data.url;
      }
      const result = await ingestDocument(store(), { text, source, title });
      return c.json(result, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  router.post("/recap", async (c) => {
    const parsed = recapSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { range, provider, model } = parsed.data;

    const db = getDb(config.databaseUrl as string).db;
    const window = dateRange(range);
    const tasks = await tasksCompletedBetween(db, window.from, window.to);
    const notes = await store().list({ type: "note", since: window.from });
    const context = assembleRecapContext(tasks, notes);

    // Summarize with the chosen model when available; otherwise return the raw
    // assembled material so a recap still works fully offline.
    let recap = context;
    if (provider && model) {
      try {
        const llm = await resolveModel(config, db, provider, model);
        const { text } = await generateText({
          model: llm,
          system: recapSystemPrompt(window.label),
          messages: [{ role: "user", content: recapMaterial(context) }],
          maxRetries: 2,
          abortSignal: AbortSignal.timeout(RECAP_TIMEOUT_MS),
        });
        recap = text;
      } catch (e) {
        recap = `(could not summarize: ${e instanceof Error ? e.message : String(e)})\n\n${context}`;
      }
    }

    return c.json({
      label: window.label,
      recap,
      tasks,
      notes,
    });
  });

  return router;
}
