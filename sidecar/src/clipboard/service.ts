import { desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type ClipboardEntry, clipboardEntries } from "../db/schema.ts";
import { detectSecret, type SecretFinding } from "./screening.ts";

/**
 * The clipboard book's storage layer: permanent snippets the palette searches
 * and copies. Every write runs through the credential screen, so the refusal
 * holds no matter which caller (palette, agent tool later) is saving.
 */

/** Raised when text offered for storage looks like a credential. */
export class CredentialRejectedError extends Error {
  readonly finding: SecretFinding;

  constructor(finding: SecretFinding) {
    super(`refusing to store the entry: it ${finding.reason}`);
    this.name = "CredentialRejectedError";
    this.finding = finding;
  }
}

export interface CreateClipboardEntryInput {
  label: string;
  content: string;
  tags?: string[];
  pinned?: boolean;
}

export interface UpdateClipboardEntryInput {
  label?: string;
  content?: string;
  tags?: string[];
  pinned?: boolean;
}

export interface ClipboardEntryFilter {
  /** Free-text match against label, content, and tags. */
  query?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 200;

/**
 * Normalizes tags to trimmed, deduplicated, lowercase values. Tags are matched
 * by substring in search, so casing differences would otherwise split what the
 * user means as one tag.
 */
function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const clean = tag.trim().toLowerCase();
    if (clean) seen.add(clean);
  }
  return [...seen];
}

function assertStorable(text: string): void {
  const finding = detectSecret(text);
  if (finding) throw new CredentialRejectedError(finding);
}

export async function createEntry(
  db: Db,
  input: CreateClipboardEntryInput,
): Promise<ClipboardEntry> {
  assertStorable(input.content);
  const [row] = await db
    .insert(clipboardEntries)
    .values({
      label: input.label,
      content: input.content,
      tags: normalizeTags(input.tags),
      pinned: input.pinned ?? false,
    })
    .returning();
  return row!;
}

/**
 * Lists entries in palette order: pinned first, then most recently used, with
 * never-used entries falling back to newest-first. An optional query narrows by
 * label, content, or tag.
 */
export async function listEntries(
  db: Db,
  filter: ClipboardEntryFilter = {},
): Promise<ClipboardEntry[]> {
  const query = filter.query?.trim();
  const where = query
    ? or(
        ilike(clipboardEntries.label, `%${query}%`),
        ilike(clipboardEntries.content, `%${query}%`),
        // Tags are jsonb; cast to text so a tag substring matches the same way
        // a label substring does.
        sql`${clipboardEntries.tags}::text ILIKE ${`%${query}%`}`,
      )
    : undefined;

  return db
    .select()
    .from(clipboardEntries)
    .where(where)
    .orderBy(
      desc(clipboardEntries.pinned),
      sql`${clipboardEntries.lastUsedAt} DESC NULLS LAST`,
      desc(clipboardEntries.createdAt),
    )
    .limit(filter.limit ?? DEFAULT_LIMIT);
}

export async function getEntry(db: Db, id: string): Promise<ClipboardEntry | null> {
  const [row] = await db.select().from(clipboardEntries).where(eq(clipboardEntries.id, id));
  return row ?? null;
}

export async function updateEntry(
  db: Db,
  id: string,
  patch: UpdateClipboardEntryInput,
): Promise<ClipboardEntry | null> {
  if (patch.content !== undefined) assertStorable(patch.content);
  const values: Partial<typeof clipboardEntries.$inferInsert> = { updatedAt: new Date() };
  if (patch.label !== undefined) values.label = patch.label;
  if (patch.content !== undefined) values.content = patch.content;
  if (patch.tags !== undefined) values.tags = normalizeTags(patch.tags);
  if (patch.pinned !== undefined) values.pinned = patch.pinned;

  const [row] = await db
    .update(clipboardEntries)
    .set(values)
    .where(eq(clipboardEntries.id, id))
    .returning();
  return row ?? null;
}

export async function deleteEntry(db: Db, id: string): Promise<ClipboardEntry | null> {
  const [row] = await db.delete(clipboardEntries).where(eq(clipboardEntries.id, id)).returning();
  return row ?? null;
}

/**
 * Records that an entry was copied, which is what moves it up the palette's
 * list. `updatedAt` is deliberately left alone: copying is not an edit.
 */
export async function markEntryUsed(db: Db, id: string): Promise<ClipboardEntry | null> {
  const [row] = await db
    .update(clipboardEntries)
    .set({
      useCount: sql`${clipboardEntries.useCount} + 1`,
      lastUsedAt: new Date(),
    })
    .where(eq(clipboardEntries.id, id))
    .returning();
  return row ?? null;
}

export interface ScanRequestItem {
  id: string;
  text: string;
}

export interface ScanResultItem {
  id: string;
  kind: string;
  reason: string;
}

/**
 * Screens a batch of clipboard-history texts, returning one result per item that
 * looks like a credential. The caller (the palette) hides those rows rather than
 * offering them for copy or save.
 */
export function scanTexts(items: ScanRequestItem[]): ScanResultItem[] {
  const flagged: ScanResultItem[] = [];
  for (const item of items) {
    const finding = detectSecret(item.text);
    if (finding) flagged.push({ id: item.id, kind: finding.kind, reason: finding.reason });
  }
  return flagged;
}
