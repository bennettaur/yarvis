import type { Db } from "../db/client.ts";
import {
  getAgentJob,
  jobIdFromSchedulerName,
  listAgentJobs,
  toJobDefinition,
} from "./agentJobs.ts";
import { ccSessionDigestJob } from "./ccSessions.ts";
import { consolidationJobs } from "./consolidate.ts";
import type { JobDefinition } from "./scheduler.ts";

/**
 * Every background job, in the order a tick considers them. Order matters where
 * one job's output is another's input: the session digests are written before the
 * day rollup that folds them in, and both are cheap enough that running them in
 * one tick is fine.
 */
export function allJobs(): JobDefinition[] {
  return [ccSessionDigestJob, ...consolidationJobs];
}

export function findJob(name: string): JobDefinition | undefined {
  return allJobs().find((job) => job.name === name);
}

/**
 * The shipped jobs plus the user's own, which are rows rather than code. Read
 * per tick so a job saved in the panel runs on the next one — see `JobProvider`.
 *
 * The user's come last: the shipped jobs write the memories a scheduled agent
 * job may well be asking about.
 */
export async function allJobsWithAgentJobs(db: Db): Promise<JobDefinition[]> {
  const agentJobs = await listAgentJobs(db).catch((e) => {
    console.error("[jobs] could not load scheduled agent jobs:", e);
    return [];
  });
  return [
    ...allJobs(),
    ...agentJobs.filter((job) => job.enabled).map((job) => toJobDefinition(job)),
  ];
}

/**
 * Resolves a scheduler name to a definition, including a user job by its id.
 *
 * A disabled job resolves here even though it is left out of a tick: "run now"
 * is the user asking for this one run, which is the whole point of being able to
 * try a job before putting it on a schedule.
 */
export async function findAnyJob(db: Db, name: string): Promise<JobDefinition | undefined> {
  const builtin = findJob(name);
  if (builtin) return builtin;
  const id = jobIdFromSchedulerName(name);
  if (!id) return undefined;
  const job = await getAgentJob(db, id);
  return job ? toJobDefinition(job) : undefined;
}
