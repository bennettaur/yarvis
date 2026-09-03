import { readSection, withSection } from "../settings/store.ts";

/**
 * Singleton store for the active embeddings provider's structural config,
 * held in the sidecar's `embeddingsConfig` section of `~/.yarvis/settings.json`.
 * Credential values live in the macOS Keychain, not here — see
 * `config.embeddingsSecrets`.
 */

const SETTINGS_KEY = "embeddingsConfig";

export interface EmbeddingsConfigInput {
  baseUrl: string;
  model: string;
  /** "openai" — both the proxy and a local Ollama speak the OpenAI API. */
  apiKind: string;
  /** Model output dimension; must equal EMBED_DIM (the column dimension). */
  dimensions: number;
  headerNames: string[];
}

/** Returns the active embeddings config, or null when none is set. */
export async function getEmbeddingsConfig(): Promise<EmbeddingsConfigInput | null> {
  const stored = await readSection<EmbeddingsConfigInput>(SETTINGS_KEY);
  return stored ?? null;
}

/** Replaces whatever embeddings config is stored — there's only ever one. */
export async function upsertEmbeddingsConfig(
  input: EmbeddingsConfigInput,
): Promise<EmbeddingsConfigInput> {
  return withSection<EmbeddingsConfigInput, EmbeddingsConfigInput>(SETTINGS_KEY, () => ({
    next: input,
    result: input,
  }));
}

/** Removes any configured embeddings provider, reverting to Gemini/hash. */
export async function deleteEmbeddingsConfig(): Promise<boolean> {
  return withSection<EmbeddingsConfigInput | undefined, boolean>(SETTINGS_KEY, (current) => ({
    next: undefined,
    result: current !== undefined,
  }));
}
