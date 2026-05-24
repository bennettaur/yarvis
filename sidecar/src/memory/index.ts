import { cosineDistance, eq } from "drizzle-orm";
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

/**
 * Stores and retrieves freeform memories by semantic similarity. The app
 * depends only on this interface, so the backing store (pgvector today,
 * OpenMemory's server later) can change without touching callers.
 */
export interface MemoryService {
  add(content: string, metadata?: Record<string, unknown>): Promise<MemoryRecord>;
  search(query: string, limit?: number): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
}

function toRecord(row: MemoryRow, score?: number): MemoryRecord {
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

  async search(query: string, limit = 5): Promise<MemoryRecord[]> {
    const queryVec = await this.embedder.embed(query);
    const distance = cosineDistance(memories.embedding, queryVec);
    const rows = await this.db
      .select({
        id: memories.id,
        content: memories.content,
        metadata: memories.metadata,
        embedding: memories.embedding,
        createdAt: memories.createdAt,
        distance,
      })
      .from(memories)
      .orderBy(distance)
      .limit(limit);
    return rows.map((r) =>
      toRecord(r as MemoryRow, 1 - Number(r.distance)),
    );
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
