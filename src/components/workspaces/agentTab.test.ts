import { describe, expect, it } from "bun:test";
import { agentSessionId, resolveAgentTab, shouldAutoStartAgent } from "./agentTab";

const base = {
  agentActive: false,
  dismissed: false,
  workspaceId: "ws1",
  cwd: "/work/ws1",
  agentName: "Claude",
};

describe("resolveAgentTab", () => {
  it("attaches to a live session at the workspace root", () => {
    const tab = resolveAgentTab({ ...base, agentActive: true });
    expect(tab).not.toBeNull();
    expect(tab?.cwd).toBe("/work/ws1");
    expect(tab?.sessionId).toBe("ws-claude:ws1");
  });

  it("never carries a command, so attaching can't re-run a ticket", () => {
    // A workspace started from an issue has its session launched on the ticket
    // by the sidecar. This surface only ever attaches to what already exists —
    // handing back a launch line would run the whole ticket a second time.
    const tab = resolveAgentTab({ ...base, agentActive: true });
    expect(tab?.initialCommand).toBeUndefined();
  });

  it("shows no tab when no session is live", () => {
    expect(resolveAgentTab(base)).toBeNull();
  });

  it("dismissed: no tab, whatever else would have produced one", () => {
    expect(resolveAgentTab({ ...base, dismissed: true, agentActive: true })).toBeNull();
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
    dismissed: false,
    workspaceStatus: "active",
    probed: true,
    agentActive: false,
    alreadyStarted: false,
  };

  it("starts for a provisioned workspace with no session yet", () => {
    expect(shouldAutoStartAgent(ready)).toBe(true);
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
    // This is also what keeps it off a workspace kicked off from an issue: the
    // sidecar launched that session before reporting the workspace provisioned,
    // so the probe answers `agentActive` and the branch below declines.
    expect(shouldAutoStartAgent({ ...ready, probed: false })).toBe(false);
  });

  it("does not start when a session is already live", () => {
    expect(shouldAutoStartAgent({ ...ready, agentActive: true })).toBe(false);
  });

  it("fires only once per view", () => {
    expect(shouldAutoStartAgent({ ...ready, alreadyStarted: true })).toBe(false);
  });
});
