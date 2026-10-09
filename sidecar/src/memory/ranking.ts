import type { MemoryKind } from "../db/schema.ts";
import { type Validity, validityAt } from "./validity.ts";

/**
 * How recall weighs a memory beyond how closely it matches the query: how long
 * it has gone unconfirmed, and whether the claim holds at the time asked about.
 * Pure, so the unit tests exercise the same scoring the store uses without a
 * database.
 *
 * The half-lives, floor and expired factor are first guesses, not tuned
 * against real recall, so they are safe to adjust.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days for an unconfirmed memory's strength to fall halfway to the floor. How a
 * user works and what they decided stay true for years, and reference material
 * close to it. Plain facts and notes go stale over months, project state moves
 * with the project, and summaries of past work matter less the further back
 * they are: an activity summary answers "what am I in the middle of", so it
 * fades within weeks.
 */
export const HALF_LIFE_DAYS: Readonly<Record<MemoryKind, number>> = {
  preference: 730,
  decision: 730,
  "agent-feedback": 365,
  doc: 365,
  fact: 180,
  note: 90,
  project: 60,
  "day-summary": 60,
  "session-summary": 45,
  "activity-summary": 14,
};

/**
 * The lowest a memory's strength falls, so decay reorders close matches
 * without burying a strong one. At the floor, an old memory still outranks a
 * fresh one whose similarity is less than 0.6 times its own.
 */
export const STRENGTH_FLOOR = 0.6;

/**
 * Multiplier for a memory past its `validUntil`. It still comes back, so the
 * agent knows to re-check it, but a current memory that matches about as well
 * and is about as fresh ranks above it.
 */
export const EXPIRED_FACTOR = 0.8;

/**
 * How much of its weight a memory keeps, from 1 when just written or confirmed
 * down to `STRENGTH_FLOOR`. Each confirmation adds a full half-life, so a
 * memory that keeps being checked and confirmed fades slower than one never
 * re-checked.
 */
export function strengthAt(
  kind: MemoryKind,
  confirmedAt: Date,
  confirmCount: number,
  at: Date,
): number {
  const ageDays = Math.max(0, at.getTime() - confirmedAt.getTime()) / DAY_MS;
  const halfLife = HALF_LIFE_DAYS[kind] * (1 + Math.max(0, confirmCount));
  return STRENGTH_FLOOR + (1 - STRENGTH_FLOOR) * 0.5 ** (ageDays / halfLife);
}

export interface MemoryScoreInput {
  kind: MemoryKind;
  /** Cosine similarity to the query, 0–1. */
  similarity: number;
  validFrom: Date;
  validUntil: Date | null;
  confirmedAt: Date;
  confirmCount: number;
}

export interface MemoryScore {
  similarity: number;
  strength: number;
  /** What results are ordered by: similarity scaled by strength, and down if expired. */
  score: number;
}

/**
 * Scores one search candidate. Decay is measured from `now`, but validity from
 * `validAt`: a question about last Tuesday wants what held last Tuesday, while
 * how long ago a memory was confirmed is a fact about today.
 */
export function scoreMemory(input: MemoryScoreInput, now: Date, validAt: Date = now): MemoryScore {
  const strength = strengthAt(input.kind, input.confirmedAt, input.confirmCount, now);
  const validity: Validity = validityAt(input.validFrom, input.validUntil, validAt);
  const score = input.similarity * strength * (validity === "expired" ? EXPIRED_FACTOR : 1);
  return { similarity: input.similarity, strength, score };
}
