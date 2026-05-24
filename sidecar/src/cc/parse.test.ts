import { describe, expect, it } from "bun:test";
import {
  extractText,
  parseHistory,
  parsePlanTitle,
  parseSessionSummary,
  parseTranscript,
} from "./parse.ts";

const transcript = [
  JSON.stringify({ type: "custom-title", customTitle: "My Session", sessionId: "s1" }),
  JSON.stringify({
    type: "user",
    sessionId: "s1",
    timestamp: "2026-05-01T10:00:00Z",
    cwd: "/Users/x/proj",
    gitBranch: "main",
    message: { role: "user", content: "first prompt" },
  }),
  JSON.stringify({
    type: "assistant",
    sessionId: "s1",
    timestamp: "2026-05-01T10:01:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", name: "Bash" },
      ],
    },
  }),
  JSON.stringify({ type: "last-prompt", lastPrompt: "final prompt", sessionId: "s1" }),
  "definitely not json{",
].join("\n");

describe("cc parsers", () => {
  it("summarizes a session, skipping malformed lines", () => {
    const s = parseSessionSummary(transcript);
    expect(s.id).toBe("s1");
    expect(s.title).toBe("My Session");
    expect(s.firstPrompt).toBe("first prompt");
    expect(s.lastPrompt).toBe("final prompt");
    expect(s.messageCount).toBe(2);
    expect(s.cwd).toBe("/Users/x/proj");
    expect(s.gitBranch).toBe("main");
    expect(s.startedAt).toBe("2026-05-01T10:00:00Z");
    expect(s.updatedAt).toBe("2026-05-01T10:01:00Z");
  });

  it("extracts text from string and block-array content", () => {
    expect(extractText("plain")).toBe("plain");
    expect(
      extractText([
        { type: "text", text: "a" },
        { type: "tool_use", name: "Edit" },
        { type: "tool_result" },
      ]),
    ).toBe("a\n[tool: Edit]\n[tool result]");
  });

  it("builds a transcript of user/assistant entries", () => {
    const entries = parseTranscript(transcript);
    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ role: "user", text: "first prompt" });
    expect(entries[1]!.text).toBe("hello\n[tool: Bash]");
  });

  it("parses history newest-first with a limit", () => {
    const content = [
      JSON.stringify({ display: "older", project: "/a", timestamp: 1 }),
      JSON.stringify({ display: "newer", project: "/b", timestamp: 2 }),
    ].join("\n");
    const entries = parseHistory(content, 1);
    expect(entries.length).toBe(1);
    expect(entries[0]!.display).toBe("newer");
  });

  it("reads the first markdown H1 as the plan title", () => {
    expect(parsePlanTitle("intro\n# The Plan\nbody")).toBe("The Plan");
    expect(parsePlanTitle("no heading here")).toBeNull();
  });
});
