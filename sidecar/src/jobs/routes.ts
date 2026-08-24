import { Hono } from "hono";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { allJobs, findJob } from "./registry.ts";
import { jobStatuses, runJob } from "./scheduler.ts";

/**
 * Job routes, mounted under /api/jobs. Read-only status plus a manual trigger,
 * so the consolidation and digest passes can be inspected and kicked from
 * Settings rather than only happening on their schedule.
 */
export function createJobRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => c.json({ jobs: await jobStatuses(allJobs(), db()) }));

  // Runs one job now. Answers with its outcome, including "busy" when the job is
  // already in flight — a second copy is refused by the lease, not queued.
  router.post("/:name/run", async (c) => {
    const job = findJob(c.req.param("name"));
    if (!job) return c.json({ error: "unknown job" }, 404);
    const result = await runJob(job, config, db());
    return c.json(result, result.status === "busy" ? 409 : 200);
  });

  return router;
}
