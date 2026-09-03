import { generateText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { EMBED_DIM, MEMORY_KINDS, type MemoryKind } from "../db/schema.ts";
import { clientError } from "../llm/errors.ts";
import { resolveModel } from "../llm/providers.ts";
import { tasksCompletedBetween } from "../tasks/service.ts";
import { memoryDebug } from "./debug.ts";
import { chooseEmbedder } from "./embedder.ts";
import {
  deleteEmbeddingsConfig,
  getEmbeddingsConfig,
  upsertEmbeddingsConfig,
} from "./embeddingsConfig.ts";
import { PgVectorMemoryStore } from "./index.ts";
import { fetchUrlText, ingestDocument } from "./ingest.ts";
import { assembleRecapContext, dateRange, recapMaterial, recapSystemPrompt } from "./recap.ts";

/** Cap the recap LLM call so a hung provider can't block the request forever. */
const RECAP_TIMEOUT_MS = 30_000;

/**
 * The kinds this endpoint may write. The summary kinds are excluded for the same
 * reason the chat tools exclude them: they are the consolidation jobs' output,
 * and hand-written text arriving as a `day-summary` would be read back as one.
 */
const WRITABLE_KINDS = [
  "fact",
  "preference",
  "note",
  "project",
  "decision",
  "agent-feedback",
] as const satisfies readonly MemoryKind[];

const addSchema = z.object({
  content: z.string().min(1),
  kind: z.enum(WRITABLE_KINDS).optional(),
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

const embeddingsConfigSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKind: z.literal("openai").default("openai"),
  dimensions: z.number().int().positive(),
  headerNames: z.array(z.string().min(1)).default([]),
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

  // Building a store resolves the active embedder, which reads the embeddings
  // provider config from the database — hence async.
  const store = async () => {
    const db = getDb(config.databaseUrl as string).db;
    return new PgVectorMemoryStore(db, await chooseEmbedder(config, db));
  };

  /**
   * Browses memories newest-first. Paginated with a total, because the browser
   * shows a page at a time once summaries start accumulating daily.
   * `?kind=` may be repeated; unknown kinds are rejected rather than ignored,
   * so a typo doesn't silently read everything.
   */
  router.get("/", async (c) => {
    const kindParams = c.req.queries("kind") ?? [];
    const known = new Set<string>(MEMORY_KINDS);
    for (const kind of kindParams) {
      if (!known.has(kind)) return c.json({ error: `unknown kind: ${kind}` }, 400);
    }
    const kinds = kindParams as MemoryKind[];
    const rawLimit = Number(c.req.query("limit") ?? "100");
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
    const rawOffset = Number(c.req.query("offset") ?? "0");
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const includeSuperseded = c.req.query("includeSuperseded") === "true";

    const memory = await store();
    const options = { kinds, limit, offset, includeSuperseded };
    const [items, total] = await Promise.all([memory.list(options), memory.count(options)]);
    return c.json({ items, total, limit, offset });
  });

  router.get("/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "missing q" }, 400);
    const limit = Number(c.req.query("limit") ?? "10");
    return c.json(await (await store()).search(q, Number.isFinite(limit) ? limit : 10));
  });

  router.post("/", async (c) => {
    const parsed = addSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await (await store()).add(parsed.data.content, { kind: parsed.data.kind }), 201);
  });

  // A note is just a memory of kind "note"; convenience endpoint.
  router.post("/notes", async (c) => {
    const parsed = addSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await (await store()).add(parsed.data.content, { kind: "note" }), 201);
  });

  router.delete("/:id", async (c) =>
    c.json({ deleted: await (await store()).delete(c.req.param("id")) }),
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
      const result = await ingestDocument(await store(), { text, source, title });
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
    const notes = await (await store()).list({ kinds: ["note"], since: window.from });
    const context = assembleRecapContext(tasks, notes);

    // Summarize with the chosen model when available; otherwise return the raw
    // assembled material so a recap still works fully offline.
    let recap = context;
    if (provider && model) {
      try {
        const llm = await resolveModel(config, provider, model);
        const { text } = await generateText({
          model: llm,
          system: recapSystemPrompt(window.label),
          messages: [{ role: "user", content: recapMaterial(context) }],
          maxRetries: 2,
          abortSignal: AbortSignal.timeout(RECAP_TIMEOUT_MS),
        });
        recap = text;
      } catch (e) {
        // `clientError` keeps the human message + HTTP status but never the raw
        // url / response body, which can carry provider-side identifiers.
        recap = `(could not summarize: ${clientError(e)})\n\n${context}`;
      }
    }

    return c.json({
      label: window.label,
      recap,
      tasks,
      notes,
    });
  });

  // --- Embeddings provider config ---

  // Current structural config (no secrets) plus embedder health: whether stored
  // memories match the active embedder. The UI uses health to warn + offer
  // re-embedding after a provider/dimension change.
  router.get("/embeddings/config", async (c) => {
    const cfg = await getEmbeddingsConfig();
    const health = await (await store()).embedderHealth();
    const stored = health.stored.reduce((sum, group) => sum + group.count, 0);
    memoryDebug(
      "memory",
      `config: provider=${cfg ? `${cfg.model}@${cfg.baseUrl}` : "none (direct Gemini/hash)"} | ` +
        `health: active=${health.active.kind}/${health.active.model} stored=${stored} ` +
        `mismatched=${health.mismatchedCount} ok=${health.ok}`,
    );
    return c.json({ config: cfg, health });
  });

  router.put("/embeddings/config", async (c) => {
    const parsed = embeddingsConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    // The model's output dimension must equal the memories column dimension.
    // Reject a mismatch here so it surfaces at save time, rather than making
    // every later memory request (including reads) fail in chooseEmbedder.
    if (parsed.data.dimensions !== EMBED_DIM) {
      return c.json(
        {
          error: `dimensions must be ${EMBED_DIM} to match the memories column; got ${parsed.data.dimensions}`,
        },
        400,
      );
    }
    const row = await upsertEmbeddingsConfig(parsed.data);
    return c.json(row);
  });

  router.delete("/embeddings/config", async (c) => {
    return c.json({ deleted: await deleteEmbeddingsConfig() });
  });

  // Re-embed every memory with the active embedder. Run after switching
  // providers (and a sidecar restart, so new secrets are loaded) to make recall
  // meaningful again.
  router.post("/reembed", async (c) => {
    const count = await (await store()).reembedAll();
    return c.json({ reembedded: count });
  });

  return router;
}
