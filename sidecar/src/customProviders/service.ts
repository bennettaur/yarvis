import { isModelCapability, type ModelInfo } from "../llm/catalog.ts";
import { readSection, withSection } from "../settings/store.ts";

/**
 * CRUD for user-configured proxy providers. Structure-only — API key and
 * header values live in the macOS Keychain and reach the sidecar via the
 * `YARVIS_CUSTOM_PROVIDER_SECRETS` env var on spawn.
 *
 * Rows live under the `customProviders` section of `~/.yarvis/settings.json`,
 * keyed by id — the same convention `config.ts` uses for
 * `customProviderSecrets: Record<string, CustomProviderSecrets>`.
 */

/**
 * Wire protocol the proxy speaks:
 * - `openai`       → Responses API (default for OpenAI SDK)
 * - `openai-chat`  → legacy `/chat/completions` endpoint, for gateways without
 *                    the Responses API
 * - `anthropic`    → Anthropic Messages API
 * - `ollama`       → Ollama's native API (`/api/chat`), whose JSON-schema
 *                    `format` is what decision models answer through. Chat
 *                    turns use the same server's OpenAI-compatible `/v1`.
 */
export type CustomProviderApiKind = "openai" | "openai-chat" | "anthropic" | "ollama";

/**
 * One model the proxy serves, tagged with what it can do. The tags decide
 * which pickers offer it, exactly as they do for a built-in provider's
 * catalogue entry.
 */
export type CustomProviderModel = Pick<ModelInfo, "id" | "capabilities">;

export interface CustomProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  models: CustomProviderModel[];
  headerNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  models: CustomProviderModel[];
  headerNames: string[];
}

export type CustomProviderUpdate = Partial<CustomProviderInput>;

const SETTINGS_KEY = "customProviders";

/**
 * A row as it sits in settings.json. A provider saved before models carried
 * tags stores bare ids, and the file can be edited by hand, so each model is
 * checked as it is read.
 */
type StoredCustomProviderRow = Omit<CustomProviderRow, "models"> & { models: unknown[] };

type CustomProvidersSection = Record<string, StoredCustomProviderRow>;

/**
 * Bare ids were all entered as chat models, since that is all the form asked
 * for, so they read back as `chat`. A tag this build doesn't know is dropped,
 * as `catalog.ts` does for its own rows, and an entry with no usable id is
 * skipped rather than failing every read of the section.
 */
function withTaggedModels(row: StoredCustomProviderRow): CustomProviderRow {
  const models = (Array.isArray(row.models) ? row.models : []).flatMap(
    (m): CustomProviderModel[] => {
      if (typeof m === "string") return m ? [{ id: m, capabilities: ["chat"] }] : [];
      const { id, capabilities } = (m ?? {}) as { id?: unknown; capabilities?: unknown };
      if (typeof id !== "string" || !id) return [];
      const tags = Array.isArray(capabilities)
        ? capabilities.filter((c): c is string => typeof c === "string").filter(isModelCapability)
        : [];
      return [{ id, capabilities: tags }];
    },
  );
  return { ...row, models };
}

export async function listCustomProviders(): Promise<CustomProviderRow[]> {
  const section = await readSection<CustomProvidersSection>(SETTINGS_KEY);
  return Object.values(section ?? {})
    .map(withTaggedModels)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function getCustomProvider(id: string): Promise<CustomProviderRow | null> {
  const section = await readSection<CustomProvidersSection>(SETTINGS_KEY);
  // An own-key check, so an id like `__proto__` can't reach the object's prototype.
  return section && Object.hasOwn(section, id) ? withTaggedModels(section[id]!) : null;
}

export async function createCustomProvider(input: CustomProviderInput): Promise<CustomProviderRow> {
  return withSection<CustomProvidersSection, CustomProviderRow>(SETTINGS_KEY, (current) => {
    const now = new Date().toISOString();
    const row: CustomProviderRow = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    return { next: { ...current, [row.id]: row }, result: row };
  });
}

export async function updateCustomProvider(
  id: string,
  patch: CustomProviderUpdate,
): Promise<CustomProviderRow | null> {
  return withSection<CustomProvidersSection, CustomProviderRow | null>(SETTINGS_KEY, (current) => {
    const existing = current && Object.hasOwn(current, id) ? current[id] : undefined;
    if (!existing) return { next: current ?? {}, result: null };
    const row: CustomProviderRow = withTaggedModels({
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    return { next: { ...current, [id]: row }, result: row };
  });
}

export async function deleteCustomProvider(id: string): Promise<boolean> {
  return withSection<CustomProvidersSection, boolean>(SETTINGS_KEY, (current) => {
    if (!current || !Object.hasOwn(current, id)) return { next: current ?? {}, result: false };
    const { [id]: _removed, ...rest } = current;
    return { next: rest, result: true };
  });
}
