import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { runSpecialist } from "./run.ts";
import {
  createSpecialist,
  deleteSpecialist,
  listSpecialists,
  resetSpecialist,
  updateSpecialist,
} from "./specialists.ts";

/**
 * Specialist routes, mounted under /api/specialists. A specialist is
 * configuration — prompt, model, tool subset — so this is a settings surface;
 * the run endpoint exists so one can be tried from the UI without going through
 * a chat turn.
 */

const definitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens"),
  description: z.string().min(1).max(1000),
  prompt: z.string().min(1).max(8000),
  toolIds: z.array(z.string().min(1).max(200)).max(64).default([]),
  provider: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  maxSteps: z.number().int().min(1).max(30).default(8),
});

const patchSchema = z.object({
  description: z.string().min(1).max(1000).optional(),
  prompt: z.string().min(1).max(8000).optional(),
  toolIds: z.array(z.string().min(1).max(200)).max(64).optional(),
  provider: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  maxSteps: z.number().int().min(1).max(30).optional(),
  enabled: z.boolean().optional(),
});

const runSchema = z.object({
  task: z.string().min(1).max(4000),
  material: z.string().max(20_000).optional(),
});

/** A trial run from the UI is bounded like a delegated one. */
const RUN_TIMEOUT_MS = 120_000;

export function createSpecialistRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => c.json(await listSpecialists(db())));

  router.post("/", async (c) => {
    const parsed = definitionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(await createSpecialist(db(), parsed.data), 201);
    } catch (e) {
      // Only the unique-name violation is the caller's fault; anything else is
      // ours and must not be reported as "that name is taken".
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("agent_specialists_name_unique_idx")) {
        return c.json({ error: "a specialist with that name already exists" }, 409);
      }
      console.error("[agents] could not create specialist:", message);
      return c.json({ error: "could not create the specialist" }, 500);
    }
  });

  router.patch("/:id", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const updated = await updateSpecialist(db(), c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  router.delete("/:id", async (c) =>
    c.json({ deleted: await deleteSpecialist(db(), c.req.param("id")) }),
  );

  // Puts a built-in back to its shipped prompt and tool set, for when an edit
  // went wrong — seeding only inserts, so without this an edit is permanent.
  router.post("/:name/reset", async (c) => {
    const reset = await resetSpecialist(db(), c.req.param("name"));
    if (!reset) return c.json({ error: "not a built-in specialist" }, 404);
    return c.json(reset);
  });

  router.post("/:name/run", async (c) => {
    const parsed = runSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const run = await runSpecialist({
        config,
        db: db(),
        name: c.req.param("name"),
        task: parsed.data.task,
        material: parsed.data.material,
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      });
      return c.json(run);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  return router;
}
