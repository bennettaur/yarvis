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
