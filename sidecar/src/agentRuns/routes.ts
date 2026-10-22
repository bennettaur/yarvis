import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import type { AgentRunEvent } from "./events.ts";
import { type AgentRunRegistry, agentRunRegistry } from "./registry.ts";
import { cancelAgentRun, getAgentRun, getAgentRunSummary, listAgentRuns } from "./service.ts";

/**
 * Reading and stopping headless Claude Code runs. Starting one is each
 * feature's own route, since what to run and against what is the feature's
 * business; these routes are the same for every kind.
 */

const idSchema = z.string().uuid();

const listQuerySchema = z.object({
  kind: z.string().min(1).max(100).optional(),
  target: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function createAgentRunRoutes(
  config: Config,
  registry: AgentRunRegistry = agentRunRegistry,
): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { kind, target, limit } = parsed.data;
    return c.json(await listAgentRuns(db(), { kind, targetKey: target, limit }));
  });

  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!idSchema.safeParse(id).success) return c.json({ error: "invalid run id" }, 400);
    const run = await getAgentRunSummary(db(), id);
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ ...run, live: registry.isLive(id) });
  });

  // Streams a run's events as SSE: what it has done so far, then what it does
  // next, ending with a `done` event. A finished run replays its stored events.
  // Closing the stream stops following; the run carries on.
  router.get("/:id/events", async (c) => {
    const id = c.req.param("id");
    if (!idSchema.safeParse(id).success) return c.json({ error: "invalid run id" }, 400);
    // Checked before the stream opens so a wrong id is a 404, not an empty stream.
    if (!registry.isLive(id) && !(await getAgentRun(db(), id))) {
      return c.json({ error: "not found" }, 404);
    }
    return streamSSE(c, async (stream) => {
      const emit = (event: AgentRunEvent) => stream.writeSSE({ data: JSON.stringify(event) });
      const gone = new AbortController();
      stream.onAbort(() => gone.abort());
      if (await registry.follow(id, emit, gone.signal)) return;
      // Not live here: it finished (or finished between the check above and
      // now), or it belongs to another instance.
      const row = await getAgentRun(db(), id);
      if (!row) return;
      for (const event of row.events as AgentRunEvent[]) await emit(event);
      if (row.status === "running") {
        await emit({
          type: "error",
          message: "this run is in progress in another Yarvis instance and can't be followed here",
        });
      }
    });
  });

  router.post("/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!idSchema.safeParse(id).success) return c.json({ error: "invalid run id" }, 400);
    if (cancelAgentRun(id, registry)) return c.json({ cancelling: true }, 202);
    const run = await getAgentRunSummary(db(), id);
    if (!run) return c.json({ error: "not found" }, 404);
    const error =
      run.status === "running"
        ? "this run is in progress in another Yarvis instance"
        : "this run has already finished";
    return c.json({ error }, 409);
  });

  return router;
}
