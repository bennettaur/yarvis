import { describe, expect, it } from "bun:test";
import { type AttentionItem, hasAnswerDialog, headsDownQuestionId } from "./attention";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a",
    seq: 1,
    source: "system",
    sessionKey: "heads-down:q1",
    workspaceId: null,
    kind: "info",
    title: "Heads down has a question",
    body: "Which PR first?",
    status: "pending",
    navTarget: { type: "heads-down" },
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

describe("headsDownQuestionId", () => {
  it("reads the question id from a heads-down question's item", () => {
    expect(headsDownQuestionId(item())).toBe("q1");
    expect(headsDownQuestionId(item({ kind: "permission" }))).toBe("q1");
  });

  it("is null for a merge alert, or an item another source raised", () => {
    expect(headsDownQuestionId(item({ sessionKey: "heads-down-merge:o/r#1" }))).toBeNull();
    expect(headsDownQuestionId(item({ source: "claude-hook" }))).toBeNull();
    expect(headsDownQuestionId(item({ sessionKey: null }))).toBeNull();
  });
});

describe("hasAnswerDialog", () => {
  it("opens heads-down questions and approvals in a dialog", () => {
    expect(hasAnswerDialog(item())).toBe(true);
    expect(hasAnswerDialog(item({ kind: "permission" }))).toBe(true);
  });

  it("leaves a heads-down merge alert to navigate", () => {
    expect(hasAnswerDialog(item({ sessionKey: "heads-down-merge:o/r#1" }))).toBe(false);
  });
});

describe("an ask_user question with a heads-down session key", () => {
  // A coding agent picks its own session key, so it could name one like this.
  const spoofed = item({ kind: "question", sessionKey: "heads-down:q1" });

  it("isn't taken for a heads-down item", () => {
    expect(headsDownQuestionId(spoofed)).toBeNull();
  });
});
