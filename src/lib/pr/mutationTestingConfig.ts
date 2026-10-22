import { ensureOk, sidecarFetch } from "../api";

/**
 * How a mutation-testing run is sized: the Claude Code model it runs on, the
 * most it may spend, and how many mutants it makes. Kept by the sidecar, which
 * reads it when a run starts.
 */
export interface MutationTestingConfig {
  /** A Claude Code model alias or id; null is Claude Code's own default. */
  model: string | null;
  maxBudgetUsd: number;
  maxMutants: number;
}

export const DEFAULT_MUTATION_TESTING_CONFIG: MutationTestingConfig = {
  model: "sonnet",
  maxBudgetUsd: 2,
  maxMutants: 12,
};

/**
 * The limits the sidecar enforces, so the inputs can say so before a save is
 * refused. Keep in sync with `mutationTestingConfigSchema` in
 * `sidecar/src/reviewWorkspaces/mutationConfig.ts`.
 */
export const MUTATION_LIMITS = {
  minBudgetUsd: 0.1,
  maxBudgetUsd: 50,
  maxMutants: 30,
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
