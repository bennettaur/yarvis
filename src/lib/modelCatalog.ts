import { ensureOk, sidecarFetch } from "./api";
import type { ModelCapability, ModelInfo } from "./chat";

/**
 * The per-provider model catalogue.
 *
 * A provider's models used to be fixed at build time, which made a model
 * released since the last build unreachable and left one the account has no
 * access to sitting in the picker. Saving a row here takes a provider's
 * catalogue over from the bundled defaults; clearing its rows hands it back.
 */

/**
 * What each tag means, shown as a checkbox's title so a list of them needs no
 * key. Its keys are also the full tag list, in the order the editors show them.
 */
export const CAPABILITY_HINTS: Record<ModelCapability, string> = {
  chat: "Can answer a chat turn — the model that thinks.",
  stt: "Can turn recorded speech into text.",
  tts: "Can speak text aloud.",
  vision: "Can read images in a prompt.",
  embed: "Can produce embedding vectors.",
  decision: "Can answer a yes/no judgement, such as whether a tool call is safe to run unasked.",
  reasoning:
    "Takes an effort level: how much it thinks before answering. Tag only models whose provider accepts it.",
};

export const MODEL_CAPABILITIES = Object.keys(CAPABILITY_HINTS) as ModelCapability[];

export interface ProviderModel {
  id: string;
  providerId: string;
  modelId: string;
  capabilities: ModelCapability[];
  enabled: boolean;
  sortOrder: number;
  compactAtTokens?: number;
}

export interface ModelCatalog {
  capabilities: ModelCapability[];
  /** What each provider offers while it has no rows of its own. */
  defaults: Record<string, ModelInfo[]>;
  models: ProviderModel[];
}

export interface ProviderModelInput {
  providerId: string;
  modelId: string;
  capabilities: ModelCapability[];
  enabled?: boolean;
  sortOrder?: number;
  /** Null clears a saved value so the global setting applies again. */
  compactAtTokens?: number | null;
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  const res = await sidecarFetch("/api/model-catalog");
  await ensureOk(res, "model catalog");
  return res.json();
}

/** Creates or updates one model, keyed on provider + model id. */
export async function saveProviderModel(input: ProviderModelInput): Promise<ProviderModel> {
  const res = await sidecarFetch("/api/model-catalog", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(res, "save model");
  return res.json();
}

export async function deleteProviderModel(providerId: string, modelId: string): Promise<void> {
  const query = new URLSearchParams({ providerId, modelId });
  const res = await sidecarFetch(`/api/model-catalog/model?${query}`, { method: "DELETE" });
  await ensureOk(res, "delete model");
}

/** Clears a provider's rows, returning it to the bundled defaults. */
export async function resetProviderModels(providerId: string): Promise<void> {
  const res = await sidecarFetch(`/api/model-catalog/provider/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
  await ensureOk(res, "reset provider models");
}
