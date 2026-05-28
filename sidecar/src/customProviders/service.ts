import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  customProviders,
  type CustomProviderRow,
} from "../db/schema.ts";

/**
 * CRUD for user-configured proxy providers. Structure-only — API key and
 * header values live in the macOS Keychain and reach the sidecar via the
 * `YARVIS_CUSTOM_PROVIDER_SECRETS` env var on spawn.
 */

/**
 * Wire protocol the proxy speaks:
 * - `openai`       → Responses API (default for OpenAI SDK)
 * - `openai-chat`  → legacy `/chat/completions` endpoint, for gateways that
 *                    haven't shipped Responses support yet (e.g. litellm)
 * - `anthropic`    → Anthropic Messages API
 */
export type CustomProviderApiKind = "openai" | "openai-chat" | "anthropic";

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  models: string[];
  headerNames: string[];
}

export type CustomProviderUpdate = Partial<CustomProviderInput>;

export async function listCustomProviders(db: Db): Promise<CustomProviderRow[]> {
  return db.select().from(customProviders).orderBy(asc(customProviders.name));
}

export async function getCustomProvider(
  db: Db,
  id: string,
): Promise<CustomProviderRow | null> {
  const [row] = await db
    .select()
    .from(customProviders)
    .where(eq(customProviders.id, id));
  return row ?? null;
}

export async function createCustomProvider(
  db: Db,
  input: CustomProviderInput,
): Promise<CustomProviderRow> {
  const [row] = await db.insert(customProviders).values(input).returning();
  return row!;
}

export async function updateCustomProvider(
  db: Db,
  id: string,
  patch: CustomProviderUpdate,
): Promise<CustomProviderRow | null> {
  const [row] = await db
    .update(customProviders)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(customProviders.id, id))
    .returning();
  return row ?? null;
}

export async function deleteCustomProvider(
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(customProviders)
    .where(eq(customProviders.id, id))
    .returning({ id: customProviders.id });
  return rows.length > 0;
}
