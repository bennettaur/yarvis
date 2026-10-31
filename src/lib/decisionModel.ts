import { ensureOk, sidecarFetch } from "./api";
import type { ModelSelection } from "./complexityModels";

/**
 * The decision model (a catalogue model tagged `decision`) and the features
 * that use it. Lives server-side because the chat turn that asks it runs in
 * the sidecar.
 */
export interface DecisionModelConfig {
  model: ModelSelection | null;
  /** Let the decision model approve an MCP tool call before the user is asked. */
  autoApproveTools: boolean;
  /** Let it approve a heads-down call to an MCP tool the user has approved in similar situations. */
  autoApproveHeadsDown: boolean;
  /** Let it pick the complexity tier for a specialist that names no model of its own. */
  routeComplexity: boolean;
  /** Let it pick the specialist for a delegation that names none. */
  pickSpecialists: boolean;
}

export const DEFAULT_DECISION_MODEL_CONFIG: DecisionModelConfig = {
  model: null,
  autoApproveTools: false,
  autoApproveHeadsDown: false,
  routeComplexity: false,
  pickSpecialists: false,
};

export async function getDecisionModelConfig(): Promise<DecisionModelConfig> {
  const res = await sidecarFetch("/api/decision-model");
  await ensureOk(res, "decision model config");
  return res.json();
}

/** Saves the given fields, leaving the rest as they are; `model: null` clears the selection. */
export async function saveDecisionModelConfig(
  patch: Partial<DecisionModelConfig>,
): Promise<DecisionModelConfig> {
  const res = await sidecarFetch("/api/decision-model", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "save decision model config");
  return res.json();
}

export interface DecisionOption {
  value: string;
  description?: string;
}

/** A playground run: a decision specialist by name, or instructions with options. */
export type DecisionTrial = { input: string; options?: DecisionOption[] } & (
  | { specialist: string }
  | { instructions: string; options: DecisionOption[] }
);

export interface DecisionTrialResult {
  choice: string;
  reason: string;
  /** The decision model that answered. */
  model: ModelSelection;
  elapsedMs: number;
}

/** Asks the saved decision model once. A failed call throws with the sidecar's reason. */
export async function tryDecision(trial: DecisionTrial): Promise<DecisionTrialResult> {
  const res = await sidecarFetch("/api/decision-playground", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trial),
  });
  await ensureOk(res, "try a decision");
  return res.json();
}
