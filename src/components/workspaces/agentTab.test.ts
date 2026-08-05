import { describe, expect, it } from "bun:test";
import {
  agentSessionId,
  buildAgentIssueCommand,
  resolveAgentTab,
  shouldAutoStartAgent,
} from "./agentTab";

const base = {
  pendingIssuePrompt: null as string | null,
  issuePromptReady: false,
  agentActive: false,
  dismissed: false,
  workspaceId: "ws1",
  cwd: "/work/ws1",
  agentName: "Claude",
  agentCommand: "claude --permission-mode auto",
};

describe("resolveAgentTab", () => {
  it("issue flow, prompt ready: launches at the workspace root with the issue command", () => {
    const tab = resolveAgentTab({
      ...base,
      pendingIssuePrompt: "do the thing",
      issuePromptReady: true,
    });
    expect(tab).not.toBeNull();
    // The issue prompt file lives at the workspace root, so the agent must launch there.
    expect(tab?.cwd).toBe("/work/ws1");
    expect(tab?.sessionId).toBe("ws-claude:ws1");
    expect(tab?.initialCommand).toBe(buildAgentIssueCommand(base.agentCommand));
  });

  it("issue flow, prompt not ready: no tab, even when a session happens to be active", () => {
    // Must wait on the prompt file, never fall through to the attach branch —
    // that would show a tab whose shell has nothing to run yet.
    const tab = resolveAgentTab({
      ...base,
      pendingIssuePrompt: "do the thing",
      issuePromptReady: false,
      agentActive: true,
    });
    expect(tab).toBeNull();
  });

  it("issue flow, session now live: attaches with no initial command", () => {
    const tab = resolveAgentTab({
      ...base,
      pendingIssuePrompt: "do the thing",
      issuePromptReady: true,
      agentActive: true,
    });
    // Once the launch has happened, a reattach must not re-run the whole ticket.
    expect(tab).not.toBeNull();
    expect(tab?.initialCommand).toBeUndefined();
  });

  it("remote-control flow, session active: attaches with no initial command", () => {
    const tab = resolveAgentTab({ ...base, agentActive: true });
    expect(tab).not.toBeNull();
    expect(tab?.cwd).toBe("/work/ws1");
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
        pendingIssuePrompt: "do the thing",
        issuePromptReady: true,
      }),
    ).toBeNull();
  });

  it("titles the tab with the configured agent name", () => {
    const tab = resolveAgentTab({ ...base, agentActive: true, agentName: "Codex" });
    expect(tab?.title).toBe("Codex");
  });
});

describe("agentSessionId", () => {
  it("keeps the ws-claude prefix so live sessions aren't orphaned", () => {
    expect(agentSessionId("ws1")).toBe("ws-claude:ws1");
  });
});

describe("shouldAutoStartAgent", () => {
  const ready = {
    pendingIssuePrompt: null as string | null,
    dismissed: false,
    workspaceStatus: "active",
    probed: true,
    agentActive: false,
    alreadyStarted: false,
  };

  it("starts for a provisioned workspace with no session yet", () => {
    expect(shouldAutoStartAgent(ready)).toBe(true);
  });

  it("does not start for the issue flow, which launches its own", () => {
    expect(shouldAutoStartAgent({ ...ready, pendingIssuePrompt: "do the thing" })).toBe(false);
  });

  it("does not start once the user has closed the tab", () => {
    expect(shouldAutoStartAgent({ ...ready, dismissed: true })).toBe(false);
  });

  it("does not start for a workspace that isn't provisioned", () => {
    for (const workspaceStatus of ["creating", "archiving", "archived", "error"]) {
      expect(shouldAutoStartAgent({ ...ready, workspaceStatus })).toBe(false);
    }
  });

  it("waits for the liveness probe, so an existing session isn't spawned twice", () => {
    expect(shouldAutoStartAgent({ ...ready, probed: false })).toBe(false);
  });

  it("does not start when a session is already live", () => {
    expect(shouldAutoStartAgent({ ...ready, agentActive: true })).toBe(false);
  });

  it("fires only once per view", () => {
    expect(shouldAutoStartAgent({ ...ready, alreadyStarted: true })).toBe(false);
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
