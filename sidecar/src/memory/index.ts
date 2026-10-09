import {
  and,
  cosineDistance,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { MemoryKind, MemoryRow, MemorySourceRef } from "../db/schema.ts";
import { memories } from "../db/schema.ts";
import { memoryDebug, preview } from "./debug.ts";
import type { Embedder, EmbedderIdentity } from "./embedder.ts";
import { scoreMemory } from "./ranking.ts";
import { type Validity, validityAt } from "./validity.ts";

export interface MemoryRecord {
  id: string;
  content: string;
  kind: MemoryKind;
  sourceRef: MemorySourceRef | null;
  metadata: unknown;
  createdAt: Date;
  supersededAt: Date | null;
  validFrom: Date;
  validUntil: Date | null;
  confirmedAt: Date;
  confirmCount: number;
  /** Whether the claim holds now, or at the `asOf` a search asked about. */
  validity: Validity;
  /** Search only: what results are ordered by — similarity scaled by strength and validity. */
  score?: number;
  /** Search only: cosine similarity to the query, 0–1. */
  similarity?: number;
  /** Search only: how much weight the memory keeps after going unconfirmed (`memory/ranking.ts`). */
  strength?: number;
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
  /**
   * Only memories whose claim held at this instant, using the validity windows
   * as they stand today, so a correction made since still applies. A superseded
   * memory counts up to where its replacement took over, so this overrides
   * `includeSuperseded`. Superseded rows are outside the HNSW index, so such a
   * search scans every row; that is acceptable only because it is rare.
   */
  asOf?: Date;
}

/** What a write records beyond the text itself. */
export interface MemoryWriteInput {
  kind?: MemoryKind;
  sourceRef?: MemorySourceRef | null;
  metadata?: Record<string, unknown>;
  /** When the claim starts holding. Defaults to now. */
  validFrom?: Date;
  /** When the claim needs re-checking. Unset means it holds until corrected. */
  validUntil?: Date;
}

export interface MemoryConfirmInput {
  /**
   * The new end of the claim's validity. Left out, the length of window the
   * memory had is applied again from now (see `extendedValidUntil`), so an
   * outage reported for an hour and confirmed still ongoing holds for another
   * hour.
   */
  validUntil?: Date;
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
 * depends only on this interface, so the backing store can change without
 * touching callers.
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
   * Null for a missing memory, or one already corrected.
   */
  supersede(id: string, content: string, input?: MemoryWriteInput): Promise<MemoryRecord | null>;
  /**
   * Records that a memory was checked and still holds: restarts its decay and
   * extends its validity. Null for a missing or superseded memory.
   */
  confirm(id: string, input?: MemoryConfirmInput): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
}

/** The columns toRecord needs — a subset of MemoryRow (the embedding is omitted
 * from list/search selects since it isn't returned to callers). */
type MemoryRowFields = Pick<
  MemoryRow,
  | "id"
  | "content"
  | "kind"
  | "sourceRef"
  | "metadata"
  | "createdAt"
  | "supersededAt"
  | "validFrom"
  | "validUntil"
  | "confirmedAt"
  | "confirmCount"
>;

/** `validAt` is the instant the record's `validity` is judged against. */
function toRecord(row: MemoryRowFields, validAt: Date): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    sourceRef: row.sourceRef ?? null,
    metadata: row.metadata,
    createdAt: row.createdAt,
    supersededAt: row.supersededAt ?? null,
    validFrom: row.validFrom,
    validUntil: row.validUntil ?? null,
    confirmedAt: row.confirmedAt,
    confirmCount: row.confirmCount,
    validity: validityAt(row.validFrom, row.validUntil ?? null, validAt),
  };
}

/**
 * A search reads this many times `limit` nearest neighbours before re-ranking,
 * because decay and expiry can lift a somewhat weaker match over a stronger
 * one. Four is a guess at how far down that reaches; a match further back than
 * that would need a large freshness gap to win.
 */
const CANDIDATE_MULTIPLIER = 4;

/**
 * The most candidates worth reading: pgvector's default `hnsw.ef_search`, the
 * most rows an HNSW index scan returns.
 */
const MAX_CANDIDATES = 40;

/**
 * Where a confirmation without an explicit end moves `validUntil`. The window
 * runs from the claim's start or its last confirmation, whichever is later, to
 * its `validUntil`, and is applied again from now (or from the claim's start,
 * if that is still ahead). One that had already closed when it was recorded or
 * last confirmed (an outage reported after it ended) keeps its end.
 */
function extendedValidUntil(record: MemoryRecord, now: Date): Date | null {
  if (!record.validUntil) return null;
  const windowStart = Math.max(record.validFrom.getTime(), record.confirmedAt.getTime());
  const windowMs = record.validUntil.getTime() - windowStart;
  if (windowMs <= 0) return record.validUntil;
  const reopensAt = Math.max(now.getTime(), record.validFrom.getTime());
  return new Date(reopensAt + windowMs);
}

/**
 * Where a corrected claim stops holding: where its replacement starts. If it
 * had already ended before then it keeps its own end, and if the replacement
 * starts before it did, it closes at its own start, recording that it never
 * held.
 */
function supersededValidUntil(
  existing: { validFrom: Date; validUntil: Date | null },
  replacementStart: Date,
): Date {
  const ownEnd = existing.validUntil?.getTime() ?? Number.POSITIVE_INFINITY;
  const endedAt = Math.min(ownEnd, replacementStart.getTime());
  return new Date(Math.max(existing.validFrom.getTime(), endedAt));
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
  validFrom: memories.validFrom,
  validUntil: memories.validUntil,
  confirmedAt: memories.confirmedAt,
  confirmCount: memories.confirmCount,
} as const;

/** MemoryService backed by Postgres + pgvector, using a pluggable embedder. */
export class PgVectorMemoryStore implements MemoryService {
  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder,
    private readonly now: () => Date = () => new Date(),
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

  /** The row a write inserts; a new memory counts as confirmed when written. */
  private rowValues(content: string, input: MemoryWriteInput, embedding: number[], now: Date) {
    return {
      content,
      kind: input.kind ?? "fact",
      sourceRef: input.sourceRef ?? null,
      metadata: this.stamp(input.metadata),
      embedding,
      validFrom: input.validFrom ?? now,
      validUntil: input.validUntil ?? null,
      confirmedAt: now,
    };
  }

  async add(content: string, input: MemoryWriteInput = {}): Promise<MemoryRecord> {
    const embedding = await this.embedder.embed(content);
    const now = this.now();
    const [row] = await this.db
      .insert(memories)
      .values(this.rowValues(content, input, embedding, now))
      .returning();
    memoryDebug(
      "memory",
      `add id=${row!.id} kind=${row!.kind} chars=${content.length} ` +
        `embedder=${this.embedder.kind} → stored`,
    );
    return toRecord(row!, now);
  }

  async addMany(items: MemoryInput[]): Promise<MemoryRecord[]> {
    if (items.length === 0) return [];
    const embeddings = await this.embedder.embedMany(items.map((i) => i.content));
    const now = this.now();
    const rows = await this.db
      .insert(memories)
      .values(items.map((item, i) => this.rowValues(item.content, item, embeddings[i]!, now)))
      .returning();
    memoryDebug("memory", `addMany count=${rows.length} embedder=${this.embedder.kind} → stored`);
    return rows.map((r) => toRecord(r, now));
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
    if (options.asOf) {
      conditions.push(lte(memories.validFrom, options.asOf));
      conditions.push(or(isNull(memories.validUntil), gt(memories.validUntil, options.asOf))!);
    } else if (!options.includeSuperseded) {
      conditions.push(isNull(memories.supersededAt));
    }
    const rows = await this.db
      .select({ ...RECORD_COLUMNS, distance })
      .from(memories)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(distance)
      .limit(Math.max(limit, Math.min(limit * CANDIDATE_MULTIPLIER, MAX_CANDIDATES)));
    const now = this.now();
    const validAt = options.asOf ?? now;
    const results = rows
      .map((r) => {
        const scored = scoreMemory({ ...r, similarity: 1 - Number(r.distance) }, now, validAt);
        return { ...toRecord(r, validAt), ...scored };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
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
    const now = this.now();
    return rows.map((r) => toRecord(r, now));
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
    return row ? toRecord(row, this.now()) : null;
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
        updatedAt: this.now(),
      })
      .where(eq(memories.id, id))
      .returning(RECORD_COLUMNS);
    return row ? toRecord(row, this.now()) : null;
  }

  async supersede(
    id: string,
    content: string,
    input: MemoryWriteInput = {},
  ): Promise<MemoryRecord | null> {
    // Embedded before the transaction, so the row lock isn't held across a
    // call to the embeddings provider.
    const embedding = await this.embedder.embed(content);
    const now = this.now();
    const replacement = await this.db.transaction(async (tx) => {
      // Locked, so two corrections of one memory racing (parallel tool calls,
      // or two instances sharing the database) can't both pass the check and
      // leave two live replacements.
      const [existing] = await tx
        .select(RECORD_COLUMNS)
        .from(memories)
        .where(eq(memories.id, id))
        .for("update");
      if (!existing || existing.supersededAt) return null;
      const values = this.rowValues(
        content,
        {
          kind: input.kind ?? existing.kind,
          sourceRef: input.sourceRef ?? existing.sourceRef ?? null,
          metadata: input.metadata,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
        },
        embedding,
        now,
      );
      const [row] = await tx.insert(memories).values(values).returning(RECORD_COLUMNS);
      await tx
        .update(memories)
        .set({
          supersededAt: now,
          supersededById: row!.id,
          validUntil: supersededValidUntil(existing, row!.validFrom),
          updatedAt: now,
        })
        .where(eq(memories.id, id));
      return row!;
    });
    if (!replacement) return null;
    memoryDebug("memory", `supersede id=${id} → ${replacement.id}`);
    return toRecord(replacement, now);
  }

  async confirm(id: string, input: MemoryConfirmInput = {}): Promise<MemoryRecord | null> {
    const existing = await this.get(id);
    if (!existing || existing.supersededAt) return null;
    const now = this.now();
    const [row] = await this.db
      .update(memories)
      .set({
        confirmedAt: now,
        confirmCount: sql`${memories.confirmCount} + 1`,
        validUntil: input.validUntil ?? extendedValidUntil(existing, now),
        updatedAt: now,
      })
      // Re-checked in the write: a correction landing after the read above must
      // not have its closed window reopened by this confirmation.
      .where(and(eq(memories.id, id), isNull(memories.supersededAt)))
      .returning(RECORD_COLUMNS);
    memoryDebug("memory", `confirm id=${id} count=${row?.confirmCount}`);
    return row ? toRecord(row, now) : null;
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
