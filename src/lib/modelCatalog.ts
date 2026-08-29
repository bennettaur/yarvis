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

export interface ProviderModel {
  id: string;
  providerId: string;
  modelId: string;
  capabilities: ModelCapability[];
  enabled: boolean;
  sortOrder: number;
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
