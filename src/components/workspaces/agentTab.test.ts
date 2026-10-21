import { describe, expect, it } from "bun:test";
import { agentSessionId, resolveAgentTab, shouldAutoStartAgent, startAgentTab } from "./agentTab";

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

describe("startAgentTab", () => {
  const SESSION = "3f2b1c9e-5d4a-4b6c-8e7f-0a1b2c3d4e5f";

  function recordingStart() {
    const calls: unknown[][] = [];
    const start = async (...args: unknown[]) => {
      calls.push(args);
    };
    return { calls, start };
  }

  it("starts the tab on the session it last ran", async () => {
    const { calls, start } = recordingStart();
    await startAgentTab("ws1", "/work/ws1", "Fix bug", {
      lookupResumable: async () => SESSION,
      start,
    });
    expect(calls).toEqual([["ws1", "/work/ws1", "Fix bug", false, SESSION]]);
  });

  it("starts a fresh session when there is nothing to resume", async () => {
    const { calls, start } = recordingStart();
    await startAgentTab("ws1", "/work/ws1", "Fix bug", {
      lookupResumable: async () => null,
      start,
    });
    expect(calls).toEqual([["ws1", "/work/ws1", "Fix bug", false, null]]);
  });

  it("still starts the tab when the lookup fails", async () => {
    const { calls, start } = recordingStart();
    await startAgentTab("ws1", "/work/ws1", "Fix bug", {
      lookupResumable: async () => {
        throw new Error("sidecar unreachable");
      },
      start,
    });
    expect(calls).toEqual([["ws1", "/work/ws1", "Fix bug", false, null]]);
  });

  it("rejects when the start itself fails", async () => {
    await expect(
      startAgentTab("ws1", "/work/ws1", "Fix bug", {
        lookupResumable: async () => null,
        start: async () => {
          throw new Error("too many PTY sessions");
        },
      }),
    ).rejects.toThrow("too many PTY sessions");
  });
});
