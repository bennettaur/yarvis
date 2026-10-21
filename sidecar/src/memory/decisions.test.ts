import { describe, expect, it } from "bun:test";
import {
  PendingQuestions,
  type Precedent,
  RELATED_SIMILARITY,
  readDecision,
  SAME_SITUATION_SIMILARITY,
  weighPrecedents,
} from "./decisions.ts";

// Kept relative to the thresholds, so retuning them doesn't quietly change what these mean.
const SAME = SAME_SITUATION_SIMILARITY;
const RELATED = RELATED_SIMILARITY;
const UNRELATED = RELATED_SIMILARITY - 0.1;

function precedent(
  id: string,
  choice: string,
  similarity: number,
  daysAgo = 1,
  action: string | null = null,
): Precedent {
  return { id, choice, action, similarity, createdAt: new Date(Date.UTC(2026, 9, 17 - daysAgo)) };
}

describe("weighPrecedents", () => {
  it("asks when nothing related was decided", () => {
    expect(weighPrecedents([precedent("a", "approve", UNRELATED)], null)).toEqual({
      verdict: "ask",
      reason: "no-precedent",
      precedentIds: [],
    });
  });

  it("decides from one answer given in the same situation", () => {
    const verdict = weighPrecedents([precedent("a", "approve", SAME)], null);
    expect(verdict).toMatchObject({
      verdict: "decide",
      choice: "approve",
      basis: "same-situation",
    });
  });

  it("follows the newest same-situation answer when the user changed their mind", () => {
    const verdict = weighPrecedents(
      [
        precedent("old-1", "approve", SAME, 30),
        precedent("old-2", "approve", SAME, 20),
        precedent("new", "decline", SAME, 1),
      ],
      null,
    );
    expect(verdict).toMatchObject({
      verdict: "decide",
      choice: "decline",
      agreeing: 1,
      disagreeing: 2,
    });
  });

  it("lets an answer in the same situation settle what related answers disagree on", () => {
    const verdict = weighPrecedents(
      [
        precedent("same", "approve", SAME),
        precedent("a", "decline", RELATED),
        precedent("b", "approve", RELATED),
      ],
      null,
    );
    expect(verdict).toMatchObject({
      verdict: "decide",
      choice: "approve",
      basis: "same-situation",
      agreeing: 2,
      disagreeing: 1,
    });
  });

  it("asks when related answers conflict", () => {
    const verdict = weighPrecedents(
      [precedent("a", "approve", RELATED), precedent("b", "decline", RELATED)],
      null,
    );
    expect(verdict).toEqual({ verdict: "ask", reason: "conflicting", precedentIds: ["a", "b"] });
  });

  it("asks when too few related answers agree", () => {
    const verdict = weighPrecedents(
      [precedent("a", "approve", RELATED), precedent("b", "approve", RELATED)],
      null,
    );
    expect(verdict).toMatchObject({ verdict: "ask", reason: "too-few" });
  });

  it("decides when enough related answers agree, ignoring case and spacing", () => {
    const verdict = weighPrecedents(
      [
        precedent("a", "Approve", RELATED),
        precedent("b", "approve ", RELATED),
        precedent("c", "approve", RELATED),
      ],
      null,
    );
    expect(verdict).toMatchObject({ verdict: "decide", basis: "consistent", agreeing: 3 });
  });

  it("only counts precedents about the same action when one is given", () => {
    const verdict = weighPrecedents(
      [
        precedent("a", "approve", SAME, 1, "archive_workspace"),
        precedent("b", "decline", RELATED, 1, "start_work_on_issue"),
      ],
      "start_work_on_issue",
    );
    expect(verdict).toEqual({ verdict: "ask", reason: "too-few", precedentIds: ["b"] });
  });

  it("doesn't let an answer about a tool decide a question about no tool", () => {
    const verdict = weighPrecedents([precedent("a", "approve", SAME, 1, "request_review")], null);
    expect(verdict).toMatchObject({ verdict: "ask", reason: "no-precedent" });
  });
});

describe("readDecision", () => {
  it("reads the detail, with a missing answer and action as null", () => {
    const metadata = { decision: { situation: "s", question: "q", choice: "approve", answer: 3 } };
    expect(readDecision({ kind: "decision", metadata })).toEqual({
      situation: "s",
      question: "q",
      choice: "approve",
      answer: null,
      action: null,
    });
  });

  it("returns null when the choice isn't a string", () => {
    const metadata = { decision: { situation: "s", question: "q", choice: 1 } };
    expect(readDecision({ kind: "decision", metadata })).toBeNull();
  });

  it("returns null for a decision stored without structured detail", () => {
    expect(readDecision({ kind: "decision", metadata: null })).toBeNull();
  });

  it("ignores the detail on a memory of another kind", () => {
    const metadata = { decision: { situation: "s", question: "q", choice: "c" } };
    expect(readDecision({ kind: "fact", metadata })).toBeNull();
  });
});

describe("PendingQuestions", () => {
  it("accepts an answer only from a later turn, and only once", () => {
    const questions = new PendingQuestions();
    const asking = {};
    const id = questions.issue("chat-1", asking);

    expect(questions.answer("chat-1", id, asking)).toBe("same-turn");
    expect(questions.answer("chat-2", id, {})).toBe("unknown");
    expect(questions.answer("chat-1", id, {})).toBe("ok");
    expect(questions.answer("chat-1", id, {})).toBe("unknown");
  });

  it("forgets a question after a day", () => {
    let now = 0;
    const questions = new PendingQuestions(() => now);
    const id = questions.issue("chat-1", {});

    now = 24 * 60 * 60_000 + 1;
    expect(questions.answer("chat-1", id, {})).toBe("unknown");
  });
});
