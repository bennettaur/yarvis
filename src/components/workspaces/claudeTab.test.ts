import { describe, expect, it } from "bun:test";
import { buildClaudeIssueCommand, resolveClaudeTab } from "./claudeTab";

const base = {
  claudePromptReady: false,
  claudeActive: false,
  workspaceId: "ws1",
  rootPath: "/work/ws1",
  claudeCwd: "/work/ws1/repo",
  claudeCommand: "claude --permission-mode auto",
};

describe("resolveClaudeTab", () => {
  it("issue flow, prompt ready: launches at the workspace root with the issue command", () => {
    const tab = resolveClaudeTab({
      ...base,
      claudePrompt: "do the thing",
      claudePromptReady: true,
    });
    expect(tab).not.toBeNull();
    // The issue prompt file lives at the workspace root, so Claude must launch there.
    expect(tab?.cwd).toBe("/work/ws1");
    expect(tab?.sessionId).toBe("ws-claude:ws1");
    expect(tab?.initialCommand).toBe(buildClaudeIssueCommand(base.claudeCommand));
  });

  it("issue flow, prompt not ready: no tab, even when a session happens to be active", () => {
    const tab = resolveClaudeTab({
      ...base,
      claudePrompt: "do the thing",
      claudePromptReady: false,
      claudeActive: true,
    });
    // Must wait on the prompt file, never fall through to the claudeActive branch.
    expect(tab).toBeNull();
  });

  it("remote-control flow, session active: attaches at claudeCwd with no initial command", () => {
    const tab = resolveClaudeTab({ ...base, claudeActive: true });
    expect(tab).not.toBeNull();
    expect(tab?.cwd).toBe("/work/ws1/repo");
    // Reattaching must never re-run a launch line on a live session.
    expect(tab?.initialCommand).toBeUndefined();
  });

  it("no prompt and no active session: no tab", () => {
    expect(resolveClaudeTab(base)).toBeNull();
  });
});

describe("buildClaudeIssueCommand", () => {
  it("appends the instruction as a double-quoted argument to the base command", () => {
    const cmd = buildClaudeIssueCommand("claude --permission-mode auto");
    expect(cmd.startsWith("claude --permission-mode auto ")).toBe(true);
    expect(cmd).toContain('"Read the ticket details in .yarvis/issue-prompt.md');
    expect(cmd.endsWith('"')).toBe(true);
  });
});
