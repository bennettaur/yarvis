import type { MemoryKind } from "../db/schema.ts";

/**
 * How recall weighs a memory beyond how closely it matches the query: how long
 * it has gone unconfirmed, and whether the claim holds at the time asked about.
 * Pure, so the store and its tests share one definition.
 */

/** Whether a memory's claim holds at a given instant. */
export type Validity = "current" | "upcoming" | "expired";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days for an unconfirmed memory's strength to fall halfway to the floor. How a
 * user works and what they decided stay true for years. Project state moves
 * with the project. Activity summaries answer "what am I in the middle of", so
 * they fade within weeks. A confirmation stretches the half-life (see
 * `strengthAt`).
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
 * The lowest a memory's strength falls. Decay reorders close matches but must
 * not bury a strong one: at the floor, a memory still outranks a fresh one that
 * matches the query less than 0.6 times as well.
 */
export const STRENGTH_FLOOR = 0.6;

/**
 * Multiplier for a memory past its `validUntil`. It still comes back, so the
 * agent knows to re-check it, but a current memory on the same topic ranks
 * above it.
 */
export const EXPIRED_FACTOR = 0.8;

export function validityAt(validFrom: Date, validUntil: Date | null, at: Date): Validity {
  if (validFrom.getTime() > at.getTime()) return "upcoming";
  if (validUntil && validUntil.getTime() <= at.getTime()) return "expired";
  return "current";
}

/**
 * How much of its weight a memory keeps, from 1 when just confirmed down to
 * `STRENGTH_FLOOR`. Each confirmation adds a full half-life, so a fact the user
 * keeps restating fades slower than one mentioned once.
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

export interface RankInput {
  kind: MemoryKind;
  /** Cosine similarity to the query, 0–1. */
  similarity: number;
  validFrom: Date;
  validUntil: Date | null;
  confirmedAt: Date;
  confirmCount: number;
}

export interface Ranking {
  similarity: number;
  strength: number;
  validity: Validity;
  /** What results are ordered by: similarity scaled by strength and validity. */
  score: number;
}

/**
 * Scores one search candidate. Decay is measured from `now`, but validity from
 * `validAt`: a question about last Tuesday wants what held last Tuesday, while
 * how long ago a memory was confirmed is a fact about today.
 */
export function rank(input: RankInput, now: Date, validAt: Date = now): Ranking {
  const strength = strengthAt(input.kind, input.confirmedAt, input.confirmCount, now);
  const validity = validityAt(input.validFrom, input.validUntil, validAt);
  const score = input.similarity * strength * (validity === "expired" ? EXPIRED_FACTOR : 1);
  return { similarity: input.similarity, strength, validity, score };
}
