import { describe, expect, it } from "bun:test";
import { buildAgentIssueCommand, resolveAgentTab } from "./agentTab";

const base = {
  claudePromptReady: false,
  agentActive: false,
  dismissed: false,
  workspaceId: "ws1",
  rootPath: "/work/ws1",
  agentCwd: "/work/ws1/repo",
  agentName: "Claude",
  agentCommand: "claude --permission-mode auto",
};

describe("resolveAgentTab", () => {
  it("issue flow, prompt ready: launches at the workspace root with the issue command", () => {
    const tab = resolveAgentTab({
      ...base,
      claudePrompt: "do the thing",
      claudePromptReady: true,
    });
    expect(tab).not.toBeNull();
    // The issue prompt file lives at the workspace root, so the agent must launch there.
    expect(tab?.cwd).toBe("/work/ws1");
    expect(tab?.sessionId).toBe("ws-claude:ws1");
    expect(tab?.initialCommand).toBe(buildAgentIssueCommand(base.agentCommand));
  });

  it("issue flow, prompt not ready: no tab", () => {
    const tab = resolveAgentTab({
      ...base,
      claudePrompt: "do the thing",
      claudePromptReady: false,
    });
    expect(tab).toBeNull();
  });

  it("issue flow, session now live: attaches with no initial command", () => {
    const tab = resolveAgentTab({
      ...base,
      claudePrompt: "do the thing",
      claudePromptReady: true,
      agentActive: true,
    });
    // Once the launch has happened, a reattach must not replay the prompt.
    expect(tab?.initialCommand).toBeUndefined();
  });

  it("remote-control flow, session active: attaches at agentCwd with no initial command", () => {
    const tab = resolveAgentTab({ ...base, agentActive: true });
    expect(tab).not.toBeNull();
    expect(tab?.cwd).toBe("/work/ws1/repo");
    // Reattaching must never re-run a launch line on a live session.
    expect(tab?.initialCommand).toBeUndefined();
  });

  it("no prompt and no active session: no tab", () => {
    expect(resolveAgentTab(base)).toBeNull();
  });

  it("dismissed: no tab, whatever else would have produced one", () => {
    // The close button has to stick. An issue prompt still pending a launch is
    // the case that used to reappear — and relaunch the agent — on reattach.
    expect(resolveAgentTab({ ...base, dismissed: true, agentActive: true })).toBeNull();
    expect(
      resolveAgentTab({
        ...base,
        dismissed: true,
        claudePrompt: "do the thing",
        claudePromptReady: true,
      }),
    ).toBeNull();
  });

  it("titles the tab with the configured agent name", () => {
    const tab = resolveAgentTab({ ...base, agentActive: true, agentName: "Codex" });
    expect(tab?.title).toBe("Codex");
  });
});

describe("buildAgentIssueCommand", () => {
  it("appends the instruction as a double-quoted argument to the base command", () => {
    const cmd = buildAgentIssueCommand("claude --permission-mode auto");
    expect(cmd.startsWith("claude --permission-mode auto ")).toBe(true);
    expect(cmd).toContain('"Read the ticket details in .yarvis/issue-prompt.md');
    expect(cmd.endsWith('"')).toBe(true);
  });
});
