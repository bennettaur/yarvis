import { and, cosineDistance, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { memories, type MemoryRow } from "../db/schema.ts";
import type { Embedder } from "./embedder.ts";

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
type MemoryRowFields = Pick<
  MemoryRow,
  "id" | "content" | "metadata" | "createdAt"
>;

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

  async add(
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<MemoryRecord> {
    const embedding = await this.embedder.embed(content);
    const [row] = await this.db
      .insert(memories)
      .values({ content, metadata: metadata ?? null, embedding })
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
          metadata: item.metadata ?? null,
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
    const [row] = await this.db
      .select()
      .from(memories)
      .where(eq(memories.id, id));
    return row ? toRecord(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(memories)
      .where(eq(memories.id, id))
      .returning({ id: memories.id });
    return deleted.length > 0;
  }
}
