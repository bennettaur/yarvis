import { describe, expect, it } from "bun:test";
import { type Precedent, readDecision, weighPrecedents } from "./decisions.ts";

const SAME = 0.95;
const RELATED = 0.8;
const UNRELATED = 0.5;

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
    expect(verdict).toMatchObject({ verdict: "decide", choice: "decline", agreeing: 1 });
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
});

describe("readDecision", () => {
  it("returns null for a decision stored without structured detail", () => {
    expect(readDecision({ kind: "decision", metadata: null })).toBeNull();
  });

  it("ignores the detail on a memory of another kind", () => {
    const metadata = { decision: { situation: "s", question: "q", choice: "c" } };
    expect(readDecision({ kind: "fact", metadata })).toBeNull();
  });
});
