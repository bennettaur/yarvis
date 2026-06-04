import { type ModelMessage, streamText } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { clientError, describeError } from "../llm/errors.ts";
import { resolveModel } from "../llm/providers.ts";
import { deleteLayout, getLayout, listLayouts, saveLayout } from "./service.ts";

/**
 * Omni UI-generation routes, mounted under /api/omni.
 *
 * The frontend owns the component catalog (it must agree with the React
 * registry that renders the result), so it builds the system prompt with
 * `catalog.prompt()` and sends it here. This endpoint is a thin LLM gateway: it
 * resolves the provider/model with the configured credentials and streams the
 * model's raw output — conversational text interleaved with json-render JSONL
 * spec patches — which the frontend splits and compiles into a live spec.
 */
const MAX_OMNI_SYSTEM_CHARS = 64 * 1024;
const MAX_OMNI_MESSAGE_CHARS = 32 * 1024;
const MAX_OMNI_MESSAGES = 200;

const generateSchema = z.object({
  // Hard cap on the system-prompt size. The catalog prompt that the frontend
  // sends is well under this; a much larger value indicates either abuse or a
  // client mistake worth surfacing as a 400 rather than billing as tokens.
  system: z.string().min(1).max(MAX_OMNI_SYSTEM_CHARS),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(MAX_OMNI_MESSAGE_CHARS),
      }),
    )
    .min(1)
    .max(MAX_OMNI_MESSAGES),
  provider: z.string().min(1),
  model: z.string().min(1),
});

const saveLayoutSchema = z.object({
  name: z.string().min(1).max(120),
  spec: z
    .object({
      root: z.string().min(1),
      elements: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
});

const idParam = z.string().uuid();

/** Saved-layout CRUD, mounted under /api/omni/layouts. Requires a database. */
function createLayoutRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => {
    const rows = await listLayouts(db());
    // The spec can be large; the list only needs summaries.
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    );
  });

  router.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = saveLayoutSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const row = await saveLayout(db(), parsed.data.name, parsed.data.spec);
    return c.json(row, 201);
  });

  router.get("/:id", async (c) => {
    if (!idParam.safeParse(c.req.param("id")).success) {
      return c.json({ error: "invalid id" }, 400);
    }
    const row = await getLayout(db(), c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  router.delete("/:id", async (c) => {
    if (!idParam.safeParse(c.req.param("id")).success) {
      return c.json({ error: "invalid id" }, 400);
    }
    const ok = await deleteLayout(db(), c.req.param("id"));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  return router;
}

export function createOmniRoutes(config: Config): Hono {
  const router = new Hono();

  router.post("/generate", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { system, messages, provider, model } = parsed.data;

    let chatModel;
    try {
      const db = config.databaseUrl ? getDb(config.databaseUrl).db : undefined;
      chatModel = await resolveModel(config, db, provider, model);
    } catch (e) {
      console.error("[omni] model resolution failed:", e);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    return streamSSE(c, async (stream) => {
      let streamError: unknown = null;
      let _chars = 0;
      let firstTokenLogged = false;
      const _startedAt = Date.now();
      const result = streamText({
        model: chatModel,
        system,
        messages: messages as ModelMessage[],
        // A rendered layout is small; cap output so a runaway generation can't
        // spend unbounded tokens.
        maxOutputTokens: 8000,
        // Cancel the upstream call if the client disconnects (e.g. navigates
        // away) instead of draining the provider with no consumer.
        abortSignal: c.req.raw.signal,
        // The AI SDK delivers provider/streaming failures here instead of
        // throwing from `textStream`; without this the stream would end
        // silently and the client would render nothing.
        onError: ({ error }) => {
          streamError = error;
          console.error("[omni] model error:", describeError(error));
        },
      });
      try {
        for await (const delta of result.textStream) {
          if (!firstTokenLogged) {
            firstTokenLogged = true;
          }
          _chars += delta.length;
          await stream.writeSSE({
            data: JSON.stringify({ type: "delta", text: delta }),
          });
        }
      } catch (e) {
        streamError = e;
        console.error("[omni] stream iteration error:", describeError(e));
      }

      if (streamError) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "error",
            message: clientError(streamError),
          }),
        });
      } else {
        await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
      }
    });
  });

  router.route("/layouts", createLayoutRoutes(config));

  return router;
}
