import type { MemoryRecord } from "./index.ts";

/**
 * Decision memory: what the user answered when the assistant asked them how to
 * proceed, kept so the same question in the same situation doesn't have to be
 * asked again.
 *
 * Each answer is a `decision` memory whose metadata carries the structured
 * parts below. Before asking, the assistant weighs the closest past answers
 * (`weighPrecedents`). It decides on its own only when they point one way;
 * otherwise it asks and records the new answer, so each answer the user gives
 * adds evidence for next time.
 */

export interface DecisionDetail {
  /** What was going on, written so it can be matched against a later situation. */
  situation: string;
  /** The question put to the user. */
  question: string;
  /**
   * A short label for the answer ("approve", "post in #team-reviews"). Answers
   * are compared by label, so the same answer has to reuse the same label.
   */
  choice: string;
  /** The user's answer in their own words, when it says more than the label. */
  answer: string | null;
  /** The tool or action the question was about, e.g. `start_work_on_issue`. */
  action: string | null;
}

/**
 * How close a past situation has to be to count as the same one, as cosine
 * similarity of the embedded situation and question. A guess to tune against
 * real decisions: paraphrases of one situation tend to land above it with the
 * hosted embedders, and different situations about the same topic below it.
 */
export const SAME_SITUATION_SIMILARITY = 0.9;

/** How close a past situation has to be to count as evidence at all. */
export const RELATED_SIMILARITY = 0.75;

/**
 * How many related, unanimous answers it takes to decide without a
 * same-situation match. One answer in a different situation says little about
 * this one; several that agree say the answer doesn't depend on the details.
 */
export const CONSISTENT_PRECEDENTS = 3;

/** A past decision as `weighPrecedents` sees it. */
export interface Precedent {
  id: string;
  choice: string;
  action: string | null;
  similarity: number;
  createdAt: Date;
}

export type DecisionVerdict =
  | {
      verdict: "decide";
      /** The precedent's label, as it was recorded. */
      choice: string;
      /**
       * `same-situation`: the newest answer given in this same situation.
       * `consistent`: related situations that all got the same answer.
       */
      basis: "same-situation" | "consistent";
      /** How many counted precedents gave this answer. */
      agreeing: number;
      precedentIds: string[];
    }
  | {
      verdict: "ask";
      /**
       * `no-precedent`: nothing related was ever decided.
       * `too-few`: related answers agree, but not enough of them to rely on.
       * `conflicting`: related answers disagree.
       */
      reason: "no-precedent" | "too-few" | "conflicting";
      precedentIds: string[];
    };

/** Labels compare without case or extra whitespace, so "Approve" and "approve " are one answer. */
export function normalizeChoice(choice: string): string {
  return choice.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Decides whether past answers settle the question. Only precedents about the
 * same action count, when an action is given.
 *
 * The newest same-situation answer wins over older ones, so a user who changed
 * their mind is followed rather than outvoted by their old answers.
 */
export function weighPrecedents(precedents: Precedent[], action: string | null): DecisionVerdict {
  const counted = precedents.filter(
    (p) => p.similarity >= RELATED_SIMILARITY && (action === null || p.action === action),
  );
  const ids = counted.map((p) => p.id);
  if (counted.length === 0) return { verdict: "ask", reason: "no-precedent", precedentIds: [] };

  const sameSituation = counted
    .filter((p) => p.similarity >= SAME_SITUATION_SIMILARITY)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const newest = sameSituation[0];
  if (newest) {
    const choice = normalizeChoice(newest.choice);
    return {
      verdict: "decide",
      choice: newest.choice,
      basis: "same-situation",
      agreeing: counted.filter((p) => normalizeChoice(p.choice) === choice).length,
      precedentIds: ids,
    };
  }

  const choices = new Set(counted.map((p) => normalizeChoice(p.choice)));
  if (choices.size > 1) return { verdict: "ask", reason: "conflicting", precedentIds: ids };
  if (counted.length < CONSISTENT_PRECEDENTS) {
    return { verdict: "ask", reason: "too-few", precedentIds: ids };
  }
  return {
    verdict: "decide",
    choice: counted[0]!.choice,
    basis: "consistent",
    agreeing: counted.length,
    precedentIds: ids,
  };
}

/** The text a decision is embedded and searched by: the situation and the question, not the answer. */
export function decisionQuery(situation: string, question: string): string {
  return `${situation}\nQuestion: ${question}`;
}

/** The memory's content: the query text plus the answer, so it reads on its own in the memory library. */
export function decisionContent(detail: DecisionDetail): string {
  const answer = detail.answer ? `${detail.choice} (${detail.answer})` : detail.choice;
  return `${decisionQuery(detail.situation, detail.question)}\nDecided: ${answer}`;
}

/**
 * The structured detail stored on a decision memory, or null for one without
 * it (a decision written with plain `remember`, which can't be weighed).
 */
export function readDecision(
  record: Pick<MemoryRecord, "kind" | "metadata">,
): DecisionDetail | null {
  if (record.kind !== "decision") return null;
  const detail = (record.metadata as { decision?: Partial<DecisionDetail> } | null)?.decision;
  if (
    typeof detail?.situation !== "string" ||
    typeof detail.question !== "string" ||
    typeof detail.choice !== "string"
  ) {
    return null;
  }
  return {
    situation: detail.situation,
    question: detail.question,
    choice: detail.choice,
    answer: typeof detail.answer === "string" ? detail.answer : null,
    action: typeof detail.action === "string" ? detail.action : null,
  };
}
