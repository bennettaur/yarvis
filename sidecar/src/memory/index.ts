import {
  and,
  cosineDistance,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { MemoryKind, MemoryRow, MemorySourceRef } from "../db/schema.ts";
import { memories } from "../db/schema.ts";
import { memoryDebug, preview } from "./debug.ts";
import type { Embedder, EmbedderIdentity } from "./embedder.ts";

export interface MemoryRecord {
  id: string;
  content: string;
  kind: MemoryKind;
  sourceRef: MemorySourceRef | null;
  metadata: unknown;
  createdAt: Date;
  supersededAt: Date | null;
  /** Cosine similarity (0–1) when returned from a search. */
  score?: number;
}

/** Filters for browsing stored memories (management UI, recaps). */
export interface MemoryListOptions {
  /** Match any of these kinds (e.g. `["note"]`, `["day-summary"]`). */
  kinds?: readonly MemoryKind[];
  /** Only memories created at or after this instant. */
  since?: Date;
  /**
   * Only memories created at or before this instant. Load-bearing for a windowed
   * read: `limit` is applied by the query, so a caller that filters an upper
   * bound in JS afterwards gets the newest rows *then* discards them — which
   * silently returns nothing for any window that isn't the most recent one.
   */
  until?: Date;
  limit?: number;
  offset?: number;
  /** Include memories the user has since corrected. Off by default. */
  includeSuperseded?: boolean;
}

/** Narrowing for a semantic search. */
export interface MemorySearchOptions {
  kinds?: readonly MemoryKind[];
  /**
   * Include superseded memories. Off by default, because a corrected fact
   * resurfacing in recall is exactly what superseding is meant to prevent.
   */
  includeSuperseded?: boolean;
}

/** What a write records beyond the text itself. */
export interface MemoryWriteInput {
  kind?: MemoryKind;
  sourceRef?: MemorySourceRef | null;
  metadata?: Record<string, unknown>;
}

/** One item for a batched memory insert. */
export interface MemoryInput extends MemoryWriteInput {
  content: string;
}

/**
 * Fields an edit may change. Content changes trigger a re-embed. Metadata is
 * deliberately not editable: it holds provenance the writer set (an ingested
 * chunk's source URL and position, the embedder identity), and a patch that
 * replaced it wholesale would quietly drop that.
 */
export interface MemoryPatch {
  content?: string;
  kind?: MemoryKind;
}

/**
 * Stores and retrieves freeform memories by semantic similarity. The app
 * depends only on this interface, so the backing store (pgvector today,
 * OpenMemory's server later) can change without touching callers.
 */
export interface MemoryService {
  add(content: string, input?: MemoryWriteInput): Promise<MemoryRecord>;
  /** Adds several memories in one embedding call + insert. */
  addMany(items: MemoryInput[]): Promise<MemoryRecord[]>;
  search(query: string, limit?: number, options?: MemorySearchOptions): Promise<MemoryRecord[]>;
  list(options?: MemoryListOptions): Promise<MemoryRecord[]>;
  count(options?: MemoryListOptions): Promise<number>;
  get(id: string): Promise<MemoryRecord | null>;
  update(id: string, patch: MemoryPatch): Promise<MemoryRecord | null>;
  /**
   * Replaces a memory's claim with a corrected one: the new text is stored as
   * its own memory and the old row is marked superseded and pointed at it.
   */
  supersede(id: string, content: string, input?: MemoryWriteInput): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
}

/** The columns toRecord needs — a subset of MemoryRow (the embedding is omitted
 * from list/search selects since it isn't returned to callers). */
type MemoryRowFields = Pick<
  MemoryRow,
  "id" | "content" | "kind" | "sourceRef" | "metadata" | "createdAt" | "supersededAt"
>;

function toRecord(row: MemoryRowFields, score?: number): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    sourceRef: row.sourceRef ?? null,
    metadata: row.metadata,
    createdAt: row.createdAt,
    supersededAt: row.supersededAt ?? null,
    score,
  };
}

/** The columns every read selects; the embedding is deliberately not among them. */
const RECORD_COLUMNS = {
  id: memories.id,
  content: memories.content,
  kind: memories.kind,
  sourceRef: memories.sourceRef,
  metadata: memories.metadata,
  createdAt: memories.createdAt,
  supersededAt: memories.supersededAt,
} as const;

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

  async add(content: string, input: MemoryWriteInput = {}): Promise<MemoryRecord> {
    const embedding = await this.embedder.embed(content);
    const [row] = await this.db
      .insert(memories)
      .values({
        content,
        kind: input.kind ?? "fact",
        sourceRef: input.sourceRef ?? null,
        metadata: this.stamp(input.metadata),
        embedding,
      })
      .returning();
    memoryDebug(
      "memory",
      `add id=${row!.id} kind=${row!.kind} chars=${content.length} ` +
        `embedder=${this.embedder.kind} → stored`,
    );
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
          kind: item.kind ?? "fact",
          sourceRef: item.sourceRef ?? null,
          metadata: this.stamp(item.metadata),
          embedding: embeddings[i]!,
        })),
      )
      .returning();
    memoryDebug("memory", `addMany count=${rows.length} embedder=${this.embedder.kind} → stored`);
    return rows.map((r) => toRecord(r));
  }

  async search(
    query: string,
    limit = 5,
    options: MemorySearchOptions = {},
  ): Promise<MemoryRecord[]> {
    const queryVec = await this.embedder.embedQuery(query);
    const distance = cosineDistance(memories.embedding, queryVec);
    const conditions: SQL[] = [];
    if (options.kinds?.length) conditions.push(inArray(memories.kind, [...options.kinds]));
    if (!options.includeSuperseded) conditions.push(isNull(memories.supersededAt));
    const rows = await this.db
      .select({ ...RECORD_COLUMNS, distance })
      .from(memories)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(distance)
      .limit(limit);
    const results = rows.map((r) => toRecord(r, 1 - Number(r.distance)));
    const top = results[0]?.score;
    memoryDebug(
      "memory",
      `search q="${preview(query)}" → ${results.length} hits` +
        (top !== undefined ? ` (top score ${top.toFixed(3)})` : ""),
    );
    return results;
  }

  /** Shared WHERE for list/count, so a paginated browse's total matches its rows. */
  private listConditions(options: MemoryListOptions): SQL | undefined {
    const conditions: SQL[] = [];
    if (options.kinds?.length) conditions.push(inArray(memories.kind, [...options.kinds]));
    if (options.since) conditions.push(gte(memories.createdAt, options.since));
    if (options.until) conditions.push(lte(memories.createdAt, options.until));
    if (!options.includeSuperseded) conditions.push(isNull(memories.supersededAt));
    return conditions.length ? and(...conditions) : undefined;
  }

  async list(options: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    const rows = await this.db
      .select(RECORD_COLUMNS)
      .from(memories)
      .where(this.listConditions(options))
      .orderBy(desc(memories.createdAt))
      .limit(options.limit ?? 100)
      .offset(options.offset ?? 0);
    return rows.map((r) => toRecord(r));
  }

  async count(options: MemoryListOptions = {}): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(memories)
      .where(this.listConditions(options));
    return Number(row?.total ?? 0);
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const [row] = await this.db.select(RECORD_COLUMNS).from(memories).where(eq(memories.id, id));
    return row ? toRecord(row) : null;
  }

  async update(id: string, patch: MemoryPatch): Promise<MemoryRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    // A changed claim needs a new vector: leaving the old one in place would
    // leave the memory findable by its previous wording and not its current one.
    const embedding =
      patch.content !== undefined && patch.content !== existing.content
        ? await this.embedder.embed(patch.content)
        : undefined;
    const [row] = await this.db
      .update(memories)
      .set({
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        // A re-embed has to re-stamp the embedder identity beside the new vector,
        // or `embedderHealth` reports the memory as produced by whatever model
        // last touched it. Existing metadata is carried through, not replaced.
        ...(embedding
          ? {
              embedding,
              metadata: this.stamp(existing.metadata as Record<string, unknown> | null),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(memories.id, id))
      .returning(RECORD_COLUMNS);
    return row ? toRecord(row) : null;
  }

  async supersede(
    id: string,
    content: string,
    input: MemoryWriteInput = {},
  ): Promise<MemoryRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const replacement = await this.add(content, {
      kind: input.kind ?? existing.kind,
      sourceRef: input.sourceRef ?? existing.sourceRef,
      metadata: input.metadata,
    });
    await this.db
      .update(memories)
      .set({ supersededAt: new Date(), supersededById: replacement.id, updatedAt: new Date() })
      .where(eq(memories.id, id));
    memoryDebug("memory", `supersede id=${id} → ${replacement.id}`);
    return replacement;
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
