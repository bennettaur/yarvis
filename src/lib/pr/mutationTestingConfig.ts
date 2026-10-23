import { ensureOk, sidecarFetch } from "../api";

/**
 * How a mutation-testing pass is sized: the Claude Code model and budget of
 * its planning run and of its explanation run, how many mutants it makes, and
 * how long one test command may run. Kept by the sidecar, which reads it when
 * a pass starts.
 */
export interface MutationTestingConfig {
  /** A Claude Code model alias or id; null is Claude Code's own default. */
  planningModel: string | null;
  planningBudgetUsd: number;
  explanationModel: string | null;
  explanationBudgetUsd: number;
  maxMutants: number;
  testTimeoutCapSeconds: number;
}

export const DEFAULT_MUTATION_TESTING_CONFIG: MutationTestingConfig = {
  planningModel: "sonnet",
  planningBudgetUsd: 1,
  explanationModel: "sonnet",
  explanationBudgetUsd: 0.5,
  maxMutants: 12,
  testTimeoutCapSeconds: 300,
};

/**
 * The limits the sidecar enforces, so the inputs can say so before a save is
 * refused. Keep in sync with `mutationTestingConfigSchema` in
 * `sidecar/src/reviewWorkspaces/mutationConfig.ts`.
 */
export const MUTATION_LIMITS = {
  planningBudgetUsd: { min: 0.1, max: 20 },
  explanationBudgetUsd: { min: 0.05, max: 20 },
  maxMutants: { min: 1, max: 30 },
  testTimeoutCapSeconds: { min: 30, max: 3600 },
} as const;

export async function getMutationTestingConfig(): Promise<MutationTestingConfig> {
  const res = await sidecarFetch("/api/mutation-testing-config");
  await ensureOk(res, "mutation testing settings");
  return res.json();
}

export async function saveMutationTestingConfig(
  patch: Partial<MutationTestingConfig>,
): Promise<MutationTestingConfig> {
  const res = await sidecarFetch("/api/mutation-testing-config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "save mutation testing settings");
  return res.json();
}
