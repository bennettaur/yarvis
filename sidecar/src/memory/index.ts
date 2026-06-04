import { and, cosineDistance, desc, eq, gte, isNotNull, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type MemoryRow, memories } from "../db/schema.ts";
import type { Embedder, EmbedderIdentity } from "./embedder.ts";

export interface MemoryRecord {
  id: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
  /** Cosine similarity (0–1) when returned from a search. */
  score?: number;
}

/** Filters for browsing stored memories (management UI, recaps). */
export interface MemoryListOptions {
  /** Match the metadata `type` tag (e.g. "note", "doc"). */
  type?: string;
  /** Only memories created at or after this instant. */
  since?: Date;
  limit?: number;
}

/**
 * Stores and retrieves freeform memories by semantic similarity. The app
 * depends only on this interface, so the backing store (pgvector today,
 * OpenMemory's server later) can change without touching callers.
 */
/** One item for a batched memory insert. */
export interface MemoryInput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryService {
  add(content: string, metadata?: Record<string, unknown>): Promise<MemoryRecord>;
  /** Adds several memories in one embedding call + insert. */
  addMany(items: MemoryInput[]): Promise<MemoryRecord[]>;
  search(query: string, limit?: number): Promise<MemoryRecord[]>;
  list(options?: MemoryListOptions): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
}

/** The columns toRecord needs — a subset of MemoryRow (the embedding is omitted
 * from list/search selects since it isn't returned to callers). */
type MemoryRowFields = Pick<MemoryRow, "id" | "content" | "metadata" | "createdAt">;

function toRecord(row: MemoryRowFields, score?: number): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.createdAt,
    score,
  };
}

/** MemoryService backed by Postgres + pgvector, using a pluggable embedder. */
export class PgVectorMemoryStore implements MemoryService {
  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder,
  ) {}

  /**
   * Records which embedder produced a vector by merging its identity into the
   * memory's metadata under `embedder`. Lets `embedderHealth` flag memories that
   * were embedded by a now-inactive model (whose vectors are no longer
   * comparable to the active one).
   */
  private stamp(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
    return { ...(metadata ?? {}), embedder: this.embedder.identity() };
  }

  async add(content: string, metadata?: Record<string, unknown>): Promise<MemoryRecord> {
    const embedding = await this.embedder.embed(content);
    const [row] = await this.db
      .insert(memories)
      .values({ content, metadata: this.stamp(metadata), embedding })
      .returning();
    return toRecord(row!);
  }

  async addMany(items: MemoryInput[]): Promise<MemoryRecord[]> {
    if (items.length === 0) return [];
    const embeddings = await this.embedder.embedMany(items.map((i) => i.content));
    const rows = await this.db
      .insert(memories)
      .values(
        items.map((item, i) => ({
          content: item.content,
          metadata: this.stamp(item.metadata),
          embedding: embeddings[i]!,
        })),
      )
      .returning();
    return rows.map((r) => toRecord(r));
  }

  async search(query: string, limit = 5): Promise<MemoryRecord[]> {
    const queryVec = await this.embedder.embed(query);
    const distance = cosineDistance(memories.embedding, queryVec);
    const rows = await this.db
      .select({
        id: memories.id,
        content: memories.content,
        metadata: memories.metadata,
        createdAt: memories.createdAt,
        distance,
      })
      .from(memories)
      .orderBy(distance)
      .limit(limit);
    return rows.map((r) => toRecord(r, 1 - Number(r.distance)));
  }

  async list(options: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    const conditions: SQL[] = [];
    if (options.type) {
      conditions.push(sql`${memories.metadata}->>'type' = ${options.type}`);
    }
    if (options.since) {
      conditions.push(gte(memories.createdAt, options.since));
    }
    const rows = await this.db
      .select({
        id: memories.id,
        content: memories.content,
        metadata: memories.metadata,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(memories.createdAt))
      .limit(options.limit ?? 100);
    return rows.map((r) => toRecord(r));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const [row] = await this.db.select().from(memories).where(eq(memories.id, id));
    return row ? toRecord(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(memories)
      .where(eq(memories.id, id))
      .returning({ id: memories.id });
    return deleted.length > 0;
  }

  /**
   * Reports the active embedder and whether any stored memories were produced
   * by a different one. A mismatch means recall is unreliable until those
   * memories are re-embedded, since vectors from different models aren't
   * comparable. Memories with an embedding but no recorded identity (e.g. from
   * before identity stamping) also count as a mismatch.
   */
  async embedderHealth(): Promise<EmbedderHealth> {
    const active = this.embedder.identity();
    const rows = await this.db
      .select({
        embedder: sql<EmbedderIdentity | null>`${memories.metadata}->'embedder'`,
        count: sql<number>`count(*)::int`,
      })
      .from(memories)
      .where(isNotNull(memories.embedding))
      .groupBy(sql`${memories.metadata}->'embedder'`);

    const stored = rows.map((r) => ({
      embedder: r.embedder ?? null,
      count: Number(r.count),
    }));
    const mismatchedCount = stored
      .filter((s) => !identityEquals(s.embedder, active))
      .reduce((sum, s) => sum + s.count, 0);

    return { active, stored, mismatchedCount, ok: mismatchedCount === 0 };
  }

  /**
   * Re-embeds every memory's existing content with the active embedder,
   * updating the vector and the recorded identity. Used to recover after a
   * dimension change or when switching embedding providers. Processes in
   * batches to bound the per-call embedding payload.
   */
  async reembedAll(batchSize = 64): Promise<number> {
    const rows = await this.db
      .select({
        id: memories.id,
        content: memories.content,
        metadata: memories.metadata,
      })
      .from(memories);

    let updated = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const embeddings = await this.embedder.embedMany(batch.map((r) => r.content));
      // The updates within a batch are independent, so issue them together
      // rather than serializing one DB round-trip per row.
      await Promise.all(
        batch.map((row, j) =>
          this.db
            .update(memories)
            .set({
              embedding: embeddings[j]!,
              metadata: this.stamp(row.metadata as Record<string, unknown> | null),
            })
            .where(eq(memories.id, row.id)),
        ),
      );
      updated += batch.length;
    }
    return updated;
  }
}

/** One group of stored memories sharing an embedder identity. */
export interface StoredEmbedderGroup {
  embedder: EmbedderIdentity | null;
  count: number;
}

/** Result of comparing the active embedder against what's stored. */
export interface EmbedderHealth {
  active: EmbedderIdentity;
  stored: StoredEmbedderGroup[];
  /** Number of stored memories not produced by the active embedder. */
  mismatchedCount: number;
  /** True when every stored memory matches the active embedder. */
  ok: boolean;
}

function identityEquals(a: EmbedderIdentity | null, b: EmbedderIdentity): boolean {
  return a !== null && a.kind === b.kind && a.model === b.model && a.dim === b.dim;
}
