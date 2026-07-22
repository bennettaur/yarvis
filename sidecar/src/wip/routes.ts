import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { getWipConfig, saveWipConfig } from "./config.ts";
import { getWipList } from "./service.ts";

const configSchema = z.object({
  sources: z.object({
    myPrs: z.boolean(),
    starredPrs: z.boolean(),
    issues: z.boolean(),
    tasks: z.boolean(),
    workspaces: z.boolean(),
  }),
  // Trim + drop blanks so a stray empty chip can't widen the label query.
  issueLabels: z.array(z.string().trim().min(1)).max(50),
});

/** Work-in-progress roll-up + its config, mounted under /api/wip. */
export function createWipRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => c.json(await getWipList(db(), config)));

  router.get("/config", async (c) => c.json(await getWipConfig(db())));

  router.put("/config", async (c) => {
    const parsed = configSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveWipConfig(db(), parsed.data));
  });

  return router;
}
