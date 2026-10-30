import { describe, expect, it } from "bun:test";
import { claudeToolType, fromClaudeHook, yarvisToolType } from "./classify.ts";
import { clipLabel } from "./hub.ts";

describe("claudeToolType", () => {
  it("classes Claude Code's tools the way the page draws them", () => {
    expect(claudeToolType("Edit")).toBe("edit");
    expect(claudeToolType("Grep")).toBe("read");
    expect(claudeToolType("WebFetch")).toBe("search");
    expect(claudeToolType("Bash")).toBe("bash");
    expect(claudeToolType("Agent")).toBe("spawn");
    expect(claudeToolType("mcp__yarvis__recall")).toBe("tool");
  });
});

describe("yarvisToolType", () => {
  it("classes Yarvis tools by their verb", () => {
    expect(yarvisToolType("delegate")).toBe("spawn");
    expect(yarvisToolType("read_web_page")).toBe("search");
    expect(yarvisToolType("jira_search_issues")).toBe("search");
    expect(yarvisToolType("recall")).toBe("search");
    expect(yarvisToolType("list_tasks")).toBe("read");
    expect(yarvisToolType("get_workspace_status")).toBe("read");
    expect(yarvisToolType("create_task")).toBe("edit");
    expect(yarvisToolType("remember")).toBe("edit");
    expect(yarvisToolType("jira_comment_on_issue")).toBe("edit");
    expect(yarvisToolType("send_workspace_instruction")).toBe("bash");
    expect(yarvisToolType("ask_user")).toBe("tool");
  });
});

describe("clipLabel", () => {
  it("keeps the log to one short line", () => {
    expect(clipLabel("a\n  b")).toBe("a b");
    const long = clipLabel("x".repeat(200));
    expect(long).toHaveLength(64);
    expect(long.endsWith("…")).toBe(true);
  });

  it("masks a secret-shaped value in a command", () => {
    expect(
      clipLabel("curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz'"),
    ).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("fromClaudeHook", () => {
  const session = "d8cb83ea-8ef9-42b0-95b2-bf4602c282bc";

  it("names the node after the workspace and session, with any subagent", () => {
    expect(
      fromClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: session }, "visualizer"),
    ).toEqual({ origin: "claude", type: "prompt", source: "visualizer:d8cb", label: "prompt" });
    expect(
      fromClaudeHook(
        { hook_event_name: "SubagentStop", session_id: session, agent_type: "Explore" },
        "visualizer",
      )?.source,
    ).toBe("visualizer:d8cb/Explore");
  });

  it("labels a tool call with the file's name, not its path", () => {
    const event = fromClaudeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/Users/me/repo/src/secret/plan.md", content: "the whole file" },
      },
      "ws",
    );
    expect(event).toMatchObject({ type: "edit", label: "Write plan.md" });
  });

  it("labels a command with its program only, leaving out arguments that may hold a secret", () => {
    const event = fromClaudeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "/usr/bin/curl -H 'X-Auth: abc123' https://api.example.com" },
      },
      "ws",
    );
    expect(event).toMatchObject({ type: "bash", label: "Bash curl" });
  });

  it("labels a fetch with the URL's host, not its path or credentials", () => {
    const event = fromClaudeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "WebFetch",
        tool_input: { url: "https://user:pass@docs.example.com/private?token=x" },
      },
      "ws",
    );
    expect(event).toMatchObject({ type: "search", label: "WebFetch docs.example.com" });
  });

  it("maps the rest of the hooks the page draws", () => {
    const type = (hook_event_name: string, extra = {}) =>
      fromClaudeHook({ hook_event_name, ...extra }, "ws")?.type;
    expect(type("PostToolUseFailure", { tool_name: "Bash" })).toBe("error");
    expect(type("Stop")).toBe("done");
    expect(type("Notification", { message: "Claude needs your permission" })).toBe("notify");
    expect(type("SessionStart")).toBe("spawn");
    expect(type("PreCompact")).toBe("notify");
  });

  it("ignores hooks the page doesn't draw", () => {
    expect(fromClaudeHook({ hook_event_name: "SessionEnd" }, "ws")).toBeNull();
    expect(fromClaudeHook({ hook_event_name: "PreToolUse" }, "ws")).toBeNull();
  });
});
