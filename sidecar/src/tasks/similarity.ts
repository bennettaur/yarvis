/**
 * Title matching for tasks, so the agent can tell "I plan to write the migration"
 * from a task it already captured yesterday.
 *
 * Deliberately lexical rather than semantic: an embedding call per candidate
 * would cost a round-trip on every "I plan to…" turn, and the thing being
 * compared is a short title the same person wrote both times, where token
 * overlap is a good enough signal. The agent still sees the near-misses and
 * decides, so a false negative costs a duplicate the user can delete, not a
 * silently dropped task.
 */

/**
 * Words carrying no distinguishing signal in a task title. Kept short on
 * purpose: dropping a real word ("review", "merge") would make two different
 * tasks look alike.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "is",
  "it",
  "this",
  "that",
  "my",
  "our",
  "i",
  "we",
]);

/** Lowercased, punctuation-stripped content words. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * Overlap of two titles' content words, 0–1. Jaccard rather than a containment
 * ratio so "fix login" doesn't score 1.0 against "fix login redirect after the
 * session expires" — a much larger task is not the same task.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(titleTokens(a));
  const right = new Set(titleTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Above this, two titles are treated as the same piece of work. */
export const DUPLICATE_THRESHOLD = 0.6;

/** Above this, a title is worth showing the agent as "did you mean this one?". */
export const SIMILAR_THRESHOLD = 0.34;
