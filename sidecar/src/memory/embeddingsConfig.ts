import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type EmbeddingsConfigRow, embeddingsConfig } from "../db/schema.ts";

/**
 * Singleton store for the active embeddings provider's structural config. Like
 * the Google token store, we keep at most one row (the most recent). Credential
 * values live in the macOS Keychain, not here — see `config.embeddingsSecrets`.
 */

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
export async function getEmbeddingsConfig(db: Db): Promise<EmbeddingsConfigRow | null> {
  const [row] = await db
    .select()
    .from(embeddingsConfig)
    .orderBy(desc(embeddingsConfig.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Upserts the singleton config: updates the existing row in place if present,
 * otherwise inserts the first one. Keeps the table to a single row.
 */
export async function upsertEmbeddingsConfig(
  db: Db,
  input: EmbeddingsConfigInput,
): Promise<EmbeddingsConfigRow> {
  const existing = await getEmbeddingsConfig(db);
  if (existing) {
    const [row] = await db
      .update(embeddingsConfig)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(embeddingsConfig.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await db.insert(embeddingsConfig).values(input).returning();
  return row!;
}

/** Removes any configured embeddings provider, reverting to Gemini/hash. */
export async function deleteEmbeddingsConfig(db: Db): Promise<boolean> {
  const rows = await db.delete(embeddingsConfig).returning({ id: embeddingsConfig.id });
  return rows.length > 0;
}
