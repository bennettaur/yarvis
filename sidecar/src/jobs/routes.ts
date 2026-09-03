import { Hono } from "hono";
import { z } from "zod";
import { listProjects } from "../cc/sessions.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { getJobConfig, saveJobConfig } from "./config.ts";
import { allJobs, findJob } from "./registry.ts";
import { jobStatuses, runJob } from "./scheduler.ts";

/**
 * A directory name, not a path: the digest resolves these under
 * `~/.claude/projects`, and `listSessionFiles` rejects anything with a separator
 * in it before touching the filesystem.
 */
const configSchema = z.object({
  ccDigestEnabled: z.boolean(),
  ccDigestProjectDirs: z
    .array(
      z
        .string()
        .min(1)
        .max(400)
        .regex(/^[A-Za-z0-9._-]+$/),
    )
    .max(200),
});

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

  // Consent settings for the jobs that reach off the machine, plus the project
  // directories available to allow, so the UI can offer them without a second
  // round-trip to the Claude Code routes.
  router.get("/config", async (c) =>
    c.json({
      config: await getJobConfig(),
      availableProjectDirs: (await listProjects()).map((p) => ({ dir: p.dir, path: p.path })),
    }),
  );

  router.put("/config", async (c) => {
    const parsed = configSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json({ config: await saveJobConfig(parsed.data) });
  });

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
