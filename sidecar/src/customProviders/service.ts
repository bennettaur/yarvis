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
 * - `openai-chat`  → legacy `/chat/completions` endpoint, for gateways that
 *                    haven't shipped Responses support yet (e.g. litellm)
 * - `anthropic`    → Anthropic Messages API
 * - `ollama`       → Ollama's native API (`/api/chat`), whose JSON-schema
 *                    `format` is what decision models answer through. Chat
 *                    turns use the same server's OpenAI-compatible `/v1`.
 * - `systemone`    → System One API (`/v1/systemone`), which answers typed
 *                    questions instead of generating text. Its models serve
 *                    the decision model only, never chat.
 */
export type CustomProviderApiKind = "openai" | "openai-chat" | "anthropic" | "ollama" | "systemone";

export interface CustomProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  models: string[];
  headerNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  models: string[];
  headerNames: string[];
}

export type CustomProviderUpdate = Partial<CustomProviderInput>;

const SETTINGS_KEY = "customProviders";

type CustomProvidersSection = Record<string, CustomProviderRow>;

/**
 * The file can be edited by hand, and a model written as `{ id, capabilities }`
 * (the catalogue's shape) instead of a bare id broke every caller that joins or
 * renders the list. Such an entry reads as its id; anything else is dropped.
 */
function withModelIds(row: CustomProviderRow): CustomProviderRow {
  const stored: unknown = row.models;
  const models = (Array.isArray(stored) ? stored : []).flatMap((m: unknown) => {
    if (typeof m === "string") return [m];
    const id = m && typeof m === "object" ? (m as { id?: unknown }).id : undefined;
    return typeof id === "string" ? [id] : [];
  });
  return { ...row, models };
}

export async function listCustomProviders(): Promise<CustomProviderRow[]> {
  const section = await readSection<CustomProvidersSection>(SETTINGS_KEY);
  return Object.values(section ?? {})
    .map(withModelIds)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function getCustomProvider(id: string): Promise<CustomProviderRow | null> {
  const section = await readSection<CustomProvidersSection>(SETTINGS_KEY);
  const row = section?.[id];
  return row ? withModelIds(row) : null;
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
    const existing = current?.[id];
    if (!existing) return { next: current ?? {}, result: null };
    const row: CustomProviderRow = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    return { next: { ...current, [id]: row }, result: row };
  });
}

export async function deleteCustomProvider(id: string): Promise<boolean> {
  return withSection<CustomProvidersSection, boolean>(SETTINGS_KEY, (current) => {
    if (!current?.[id]) return { next: current ?? {}, result: false };
    const { [id]: _removed, ...rest } = current;
    return { next: rest, result: true };
  });
}
