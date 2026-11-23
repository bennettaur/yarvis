import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  dismissInvestigation,
  getRevertInvestigationSettings,
  listInvestigations,
  saveRevertInvestigationSettings,
  startInvestigation,
} from "./service.ts";

const settingsSchema = z.object({ autoStart: z.boolean() });

export function createRevertInvestigationRoutes(config: Config): Hono {
  const router = new Hono();
  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });
  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => c.json({ investigations: await listInvestigations(db()) }));

  router.post("/:id/start", async (c) => {
    const result = await startInvestigation(db(), config, c.req.param("id"));
    return "error" in result ? c.json(result, 409) : c.json(result);
  });

  router.post("/:id/dismiss", async (c) => {
    if (!(await dismissInvestigation(db(), c.req.param("id")))) {
      return c.json({ error: "not found, or already acted on" }, 404);
    }
    return c.json({ ok: true });
  });

  router.get("/settings", async (c) => c.json(await getRevertInvestigationSettings()));

  router.put("/settings", async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveRevertInvestigationSettings(parsed.data));
  });

  return router;
}
