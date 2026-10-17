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
 *
 * A precedent lets the assistant skip asking, so it is consent the user gave
 * once and the assistant reuses. Two rules keep it from being forged:
 * an answer is recorded only against a question `PendingQuestions` handed out
 * in an earlier turn, and no precedent stands in for a tool that needs the
 * user's go-ahead (`chat/destructiveTools.ts`).
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
      /** How many counted precedents gave this answer, and how many gave another. */
      agreeing: number;
      disagreeing: number;
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
 * same action count, and a question about no particular action counts only
 * precedents about none, so an answer given for one tool never decides another.
 *
 * The newest same-situation answer wins over older ones, so a user who changed
 * their mind is followed rather than outvoted by their old answers.
 */
export function weighPrecedents(precedents: Precedent[], action: string | null): DecisionVerdict {
  const counted = precedents.filter(
    (p) => p.similarity >= RELATED_SIMILARITY && p.action === action,
  );
  if (counted.length === 0) return { verdict: "ask", reason: "no-precedent", precedentIds: [] };
  const precedentIds = counted.map((p) => p.id);

  const sameSituation = counted
    .filter((p) => p.similarity >= SAME_SITUATION_SIMILARITY)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const newest = sameSituation[0];
  if (newest) {
    const newestChoice = normalizeChoice(newest.choice);
    const agreeing = counted.filter((p) => normalizeChoice(p.choice) === newestChoice).length;
    return {
      verdict: "decide",
      choice: newest.choice,
      basis: "same-situation",
      agreeing,
      disagreeing: counted.length - agreeing,
      precedentIds,
    };
  }

  const choices = new Set(counted.map((p) => normalizeChoice(p.choice)));
  if (choices.size > 1) return { verdict: "ask", reason: "conflicting", precedentIds };
  if (counted.length < CONSISTENT_PRECEDENTS) {
    return { verdict: "ask", reason: "too-few", precedentIds };
  }
  return {
    verdict: "decide",
    choice: counted[0]!.choice,
    basis: "consistent",
    agreeing: counted.length,
    disagreeing: 0,
    precedentIds,
  };
}

/** The text a decision is found by: the situation and the question, not the answer. */
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

/** How long a handed-out question can still be answered. */
const QUESTION_TTL_MS = 24 * 60 * 60_000;

/** Open questions kept per chat. The oldest is dropped past this. */
const MAX_OPEN_QUESTIONS = 20;

interface OpenQuestion {
  /** The turn that asked it. Identity only: each turn builds its tools afresh. */
  turn: object;
  askedAt: number;
}

/**
 * The questions `consult_decisions` handed out, per chat session, so
 * `record_decision` only stores an answer to a question the assistant asked.
 *
 * The answer has to arrive in a later turn than the question. Text the
 * assistant read during a turn (an issue body, a Slack message) can tell it to
 * record a decision, but it can't make the user send a message. In memory only:
 * after a restart, an unanswered question is asked again rather than recorded.
 */
export class PendingQuestions {
  private readonly bySession = new Map<string, Map<string, OpenQuestion>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Hands out an id for a question asked in `turn`. */
  issue(sessionId: string, turn: object): string {
    const open = this.bySession.get(sessionId) ?? new Map<string, OpenQuestion>();
    this.bySession.set(sessionId, open);
    const id = crypto.randomUUID();
    open.set(id, { turn, askedAt: this.now() });
    if (open.size > MAX_OPEN_QUESTIONS) open.delete(open.keys().next().value!);
    return id;
  }

  /**
   * Uses up a question if it may be answered from `turn`: it was handed out in
   * this session, in an earlier turn, and hasn't expired or been answered.
   */
  answer(sessionId: string, questionId: string, turn: object): "ok" | "unknown" | "same-turn" {
    const open = this.bySession.get(sessionId);
    const question = open?.get(questionId);
    if (!open || !question || this.now() - question.askedAt > QUESTION_TTL_MS) return "unknown";
    if (question.turn === turn) return "same-turn";
    open.delete(questionId);
    return "ok";
  }
}
