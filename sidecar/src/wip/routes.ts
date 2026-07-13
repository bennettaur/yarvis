import { Hono } from "hono";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { getWipList } from "./service.ts";

/** Work-in-progress roll-up, mounted under /api/wip. Read-only + derived. */
export function createWipRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  router.get("/", async (c) => {
    const db = getDb(config.databaseUrl as string).db;
    return c.json(await getWipList(db, config));
  });

  return router;
}
