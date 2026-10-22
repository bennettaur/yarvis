import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunEvent } from "./events.ts";
import { type ClaudeStreamResult, StreamJsonParser, summarizeToolInput } from "./streamJson.ts";

/**
 * The fixtures are trimmed captures of real `claude -p --output-format
 * stream-json --verbose` runs (Claude Code 2.1.307): one that delegated to a
 * subagent, read a file and answered through `--json-schema`, and one whose API
 * calls all failed.
 */
function parseFixture(name: string): { events: AgentRunEvent[]; result?: ClaudeStreamResult } {
  const parser = new StreamJsonParser("/work/repo");
  const events: AgentRunEvent[] = [];
  let result: ClaudeStreamResult | undefined;
  for (const line of readFileSync(join(import.meta.dir, "fixtures", name), "utf8").split("\n")) {
    const parsed = parser.parseLine(line);
    events.push(...parsed.events);
    if (parsed.result) result = parsed.result;
  }
  return { events, result };
}

describe("reading a captured run", () => {
  const { events, result } = parseFixture("subagent-structured-output.jsonl");

  it("reports the session starting, with the plugins it loaded", () => {
    expect(events[0]).toEqual({
      type: "status",
      message: "Claude Code started with claude-haiku-5-5 (plugins: yarvis-review)",
    });
  });

  it("brackets a delegation with start and stop, and nests its tool calls under it", () => {
    const delegationId = "toolu_01SbbaCQXc87rsRfRULmJanP";
    expect(events).toContainEqual({
      type: "subagent",
      phase: "start",
      id: delegationId,
      name: "general-purpose",
      description: "List files in current directory",
    });
    expect(events).toContainEqual({
      type: "subagent",
      phase: "stop",
      id: delegationId,
      name: "general-purpose",
      description: "List files in current directory",
      failed: false,
    });
    const subagentTools = events.filter(
      (event) => event.type === "tool" && event.subagentId === delegationId,
    );
    expect(subagentTools).toHaveLength(2);
    expect(subagentTools[0]).toMatchObject({ name: "Bash", summary: "ls" });
  });

  it("shows the main agent's own tool calls with paths relative to the run", () => {
    expect(events).toContainEqual({
      type: "tool",
      id: "toolu_012Xjj9yiRVi932ZvynhQZqY",
      name: "Read",
      summary: "a.txt",
      subagentId: null,
    });
  });

  it("keeps the delegation tool and the structured-output tool out of the tool list", () => {
    const names = events.flatMap((event) => (event.type === "tool" ? [event.name] : []));
    expect(names).not.toContain("Agent");
    expect(names).not.toContain("StructuredOutput");
  });

  it("passes the main agent's text through", () => {
    const texts = events.filter((event) => event.type === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ subagentId: null });
    expect((texts[0] as { text: string }).text).toStartWith("There are 2 files");
  });

  it("reads the structured output, cost and session from the result line", () => {
    expect(result).toEqual({
      isError: false,
      subtype: "success",
      text: '{"count":2}',
      structuredOutput: { count: 2 },
      costUsd: 0.012149559999999998,
      durationMs: 14832,
      sessionId: "e4aa03c0-b411-4d9f-9a54-fd1d3f9870af",
    });
  });
});

describe("reading a run that failed at the API", () => {
  const { events, result } = parseFixture("api-error.jsonl");

  it("reports the retries", () => {
    expect(events).toContainEqual({
      type: "status",
      message: "The API request failed; retrying (attempt 1 of 10)",
    });
  });

  it("marks the result as an error with the reason as its text", () => {
    expect(result?.isError).toBe(true);
    expect(result?.text).toStartWith("API Error:");
    expect(result?.structuredOutput).toBeNull();
  });
});

describe("lines it doesn't understand", () => {
  it("skips malformed and unknown lines rather than failing", () => {
    const parser = new StreamJsonParser("/work/repo");
    expect(parser.parseLine("not json").events).toEqual([]);
    expect(parser.parseLine('{"type":"brand_new_thing"}').events).toEqual([]);
    expect(parser.parseLine("[1,2]").events).toEqual([]);
    expect(parser.parseLine("").events).toEqual([]);
  });

  it("redacts credential shapes from text before it becomes an event", () => {
    const parser = new StreamJsonParser("/work/repo");
    const line = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "the key is sk-ant-abcdefghijklmnopqrstuvwx" }] },
    });
    const [event] = parser.parseLine(line).events;
    expect(event).toMatchObject({ type: "text" });
    expect(JSON.stringify(event)).not.toContain("abcdefghijklmnop");
  });
});

describe("summarising a tool call", () => {
  it("shows the command a shell call runs, on one line and capped", () => {
    expect(summarizeToolInput("Bash", { command: "bun test\n  --watch" }, "/r")).toBe(
      "bun test --watch",
    );
    expect(summarizeToolInput("Bash", { command: "x".repeat(500) }, "/r").length).toBe(160);
  });

  it("keeps a path outside the run's directory absolute", () => {
    expect(summarizeToolInput("Read", { file_path: "/etc/hosts" }, "/work/repo")).toBe(
      "/etc/hosts",
    );
  });

  it("names the pattern and where a search looks", () => {
    expect(
      summarizeToolInput("Grep", { pattern: "TODO", path: "/work/repo/src" }, "/work/repo"),
    ).toBe("TODO in src");
  });

  it("falls back to the first string argument of a tool it doesn't know", () => {
    expect(summarizeToolInput("mcp__x__lookup", { limit: 3, query: "flaky tests" }, "/r")).toBe(
      "flaky tests",
    );
  });

  it("redacts a credential a command carries", () => {
    const summary = summarizeToolInput(
      "Bash",
      { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' x" },
      "/r",
    );
    expect(summary).not.toContain("abcdefghijklmnop");
  });
});

/** Builds stream-json lines for the delegation cases below. */
const line = (value: unknown) => JSON.stringify(value);
const delegate = (id: string, background = false) =>
  line({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: `msg_${id}`,
      content: [
        {
          type: "tool_use",
          id,
          name: "Agent",
          input: { subagent_type: "reviewer", description: "look", run_in_background: background },
        },
      ],
    },
  });
const toolResult = (id: string, isError = false) =>
  line({
    type: "user",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "x" }],
    },
  });

describe("delegations", () => {
  it("marks a delegation that ended in an error as failed", () => {
    const parser = new StreamJsonParser("/r");
    parser.parseLine(delegate("t1"));
    expect(parser.parseLine(toolResult("t1", true)).events).toEqual([
      {
        type: "subagent",
        phase: "stop",
        id: "t1",
        name: "reviewer",
        description: "look",
        failed: true,
      },
    ]);
  });

  it("waits for a backgrounded delegation's task to end, not its launch result", () => {
    const parser = new StreamJsonParser("/r");
    parser.parseLine(delegate("t2", true));
    parser.parseLine(
      line({ type: "system", subtype: "task_started", task_id: "task-2", tool_use_id: "t2" }),
    );
    expect(parser.parseLine(toolResult("t2")).events).toEqual([]);
    const ended = parser.parseLine(
      line({
        type: "system",
        subtype: "task_updated",
        task_id: "task-2",
        patch: { status: "completed" },
      }),
    );
    expect(ended.events).toMatchObject([
      { type: "subagent", phase: "stop", id: "t2", failed: false },
    ]);
  });

  it("closes delegations still open when the run stops, as failed", () => {
    const parser = new StreamJsonParser("/r");
    parser.parseLine(delegate("t3"));
    expect(parser.closeOpenDelegations()).toMatchObject([
      { type: "subagent", phase: "stop", id: "t3", failed: true },
    ]);
    expect(parser.closeOpenDelegations()).toEqual([]);
  });
});

describe("estimating what a run has spent", () => {
  it("counts each API message once, however many lines repeat its usage", () => {
    const parser = new StreamJsonParser("/r");
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    const message = (block: unknown) =>
      line({
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg_1", model: "claude-opus-5-5", usage, content: [block] },
      });
    parser.parseLine(message({ type: "text", text: "a" }));
    parser.parseLine(message({ type: "text", text: "b" }));
    expect(parser.estimatedCostUsd).toBeCloseTo(4);
  });

  it("prices a model it doesn't know at the dearest rates rather than at nothing", () => {
    const parser = new StreamJsonParser("/r");
    parser.parseLine(
      line({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "msg_2",
          model: "claude-future-9",
          usage: { output_tokens: 1_000_000 },
          content: [],
        },
      }),
    );
    expect(parser.estimatedCostUsd).toBeCloseTo(50);
  });
});
