import { Hono } from "hono";
import { z } from "zod";
import { listProjects } from "../cc/sessions.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  type AgentJobInput,
  agentJobStatuses,
  CLAUDE_PERMISSION_MODES,
  createAgentJob,
  deleteAgentJob,
  getAgentJob,
  getAgentJobRun,
  jobSchedulerName,
  listAgentJobRuns,
  updateAgentJob,
} from "./agentJobs.ts";
import { getJobConfig, saveJobConfig } from "./config.ts";
import { isValidCron } from "./cron.ts";
import { allJobs, findAnyJob, findJob } from "./registry.ts";
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
 * A user-defined scheduled job, as the panel submits it.
 *
 * The prompt is capped because it is stored and sent to an agent on a schedule;
 * the cron expression is checked against the parser here so a job can never be
 * saved with a schedule the tick would refuse to run.
 */
const agentJobSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1_000).nullish(),
  cron: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(isValidCron, { message: "not a valid cron expression" }),
  prompt: z.string().trim().min(1).max(20_000),
  enabled: z.boolean(),
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("yarvis"),
      specialist: z.string().trim().min(1).max(200).nullish(),
    }),
    z.object({
      kind: z.literal("claude-code"),
      // Checked for existence when the job runs rather than here: a directory
      // can be removed between saving a job and running it, so the runner has
      // to check anyway, and refusing to save a path that is temporarily
      // unmounted would be the wrong call.
      cwd: z.string().trim().min(1).max(1_000),
      model: z.string().trim().max(200).nullish(),
      permissionMode: z.enum(CLAUDE_PERMISSION_MODES).nullish(),
    }),
  ]),
});

type AgentJobBody = z.infer<typeof agentJobSchema>;

function toInput(body: AgentJobBody): AgentJobInput {
  return {
    name: body.name,
    description: body.description ?? null,
    cron: body.cron,
    prompt: body.prompt,
    enabled: body.enabled,
    target:
      body.target.kind === "yarvis"
        ? { kind: "yarvis", specialist: body.target.specialist ?? null }
        : {
            kind: "claude-code",
            cwd: body.target.cwd,
            model: body.target.model ?? null,
            permissionMode: body.target.permissionMode ?? null,
          },
  };
}

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

  router.get("/agent-jobs", async (c) => c.json({ jobs: await agentJobStatuses(db()) }));

  router.post("/agent-jobs", async (c) => {
    const parsed = agentJobSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json({ job: await createAgentJob(db(), toInput(parsed.data)) }, 201);
  });

  router.put("/agent-jobs/:id", async (c) => {
    const parsed = agentJobSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const job = await updateAgentJob(db(), c.req.param("id"), toInput(parsed.data));
    if (!job) return c.json({ error: "unknown job" }, 404);
    return c.json({ job });
  });

  router.delete("/agent-jobs/:id", async (c) => {
    const deleted = await deleteAgentJob(db(), c.req.param("id"));
    if (!deleted) return c.json({ error: "unknown job" }, 404);
    return c.json({ deleted: true });
  });

  // The runs a job has had, newest first. The output itself rides along: a run's
  // answer is the reason the history exists, and the panel shows it inline.
  router.get("/agent-jobs/:id/runs", async (c) => {
    const job = await getAgentJob(db(), c.req.param("id"));
    if (!job) return c.json({ error: "unknown job" }, 404);
    return c.json({ runs: await listAgentJobRuns(db(), job.id) });
  });

  router.get("/agent-jobs/runs/:runId", async (c) => {
    const run = await getAgentJobRun(db(), c.req.param("runId"));
    if (!run) return c.json({ error: "unknown run" }, 404);
    return c.json({ run });
  });

  // Runs a user's job now, schedule or not — trying a job before putting it on
  // one is the point. The outcome includes "busy" when the job is already in
  // flight: a second copy is refused by the lease, not queued.
  router.post("/agent-jobs/:id/run", async (c) => {
    const definition = await findAnyJob(db(), jobSchedulerName(c.req.param("id")));
    if (!definition) return c.json({ error: "unknown job" }, 404);
    const result = await runJob(definition, config, db(), new Date(), "manual");
    return c.json(result, result.status === "busy" ? 409 : 200);
  });

  // Same, for the jobs this repo ships as code.
  router.post("/:name/run", async (c) => {
    const job = findJob(c.req.param("name"));
    if (!job) return c.json({ error: "unknown job" }, 404);
    const result = await runJob(job, config, db(), new Date(), "manual");
    return c.json(result, result.status === "busy" ? 409 : 200);
  });

  return router;
}
