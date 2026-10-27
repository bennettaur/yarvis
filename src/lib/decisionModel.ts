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
}

export const DEFAULT_DECISION_MODEL_CONFIG: DecisionModelConfig = {
  model: null,
  autoApproveTools: false,
  autoApproveHeadsDown: false,
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
