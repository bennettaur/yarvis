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

/** A row as read from the file, whose `models` may have been edited by hand. */
type StoredRow = Omit<CustomProviderRow, "models"> & { models?: unknown };

type CustomProvidersSection = Record<string, StoredRow>;

/**
 * settings.json can be edited by hand, and a model may be written in the
 * `{ id, capabilities }` shape from `llm/catalog.ts` instead of a bare id.
 * Callers join and render `models` as strings, so such an entry reads as its
 * id and anything else is dropped.
 */
function withModelIds(row: StoredRow): CustomProviderRow {
  const models = (Array.isArray(row.models) ? row.models : []).flatMap((m: unknown) => {
    if (typeof m === "string") return [m];
    if (typeof m === "object" && m !== null && "id" in m && typeof m.id === "string") {
      return [m.id];
    }
    return [];
  });
  return { ...row, models };
}

/** An own key only, so an id like `constructor` doesn't find an inherited value. */
function storedRow(section: CustomProvidersSection | undefined, id: string): StoredRow | null {
  return section && Object.hasOwn(section, id) ? (section[id] ?? null) : null;
}

export async function listCustomProviders(): Promise<CustomProviderRow[]> {
  const section = await readSection<CustomProvidersSection>(SETTINGS_KEY);
  return Object.values(section ?? {})
    .map(withModelIds)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function getCustomProvider(id: string): Promise<CustomProviderRow | null> {
  const row = storedRow(await readSection<CustomProvidersSection>(SETTINGS_KEY), id);
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
    const existing = storedRow(current, id);
    if (!existing) return { next: current ?? {}, result: null };
    const row: CustomProviderRow = {
      ...withModelIds(existing),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
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
