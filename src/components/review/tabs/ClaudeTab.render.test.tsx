import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { resetPtyApi, stubPtyApi } from "../../../test/ptyApi";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import ClaudeTab from "./ClaudeTab";
import type { TabContext } from "./types";

const pr = {
  id: "pr1",
  ref: { provider: "github", owner: "octo", repo: "repo", number: 7 },
  status: "ready",
  worktreeStatus: "ready",
  worktreePath: "/review/pr1",
  headSha: "a".repeat(40),
} as ReviewWorkspacePr;

const ctxFor = (p: ReviewWorkspacePr): TabContext => ({
  workspaceId: "ws",
  pr: p,
  prRef: p.ref,
  diffMode: "split",
  openTab: () => {},
  openSetup: () => {},
});

let live: boolean;
let starts: string[];
let startFails: boolean;
let attached: string[];
let kills: string[];
let mounted: { unmount: () => void } | null = null;
/** Set when this file installed the IntersectionObserver stub, so it can undo it. */
let installedObserver = false;

/** xterm's accessibility manager constructs one on open, and happy-dom has none. */
class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const globalWithObserver = globalThis as { IntersectionObserver?: unknown };

beforeEach(() => {
  if (!globalWithObserver.IntersectionObserver) {
    globalWithObserver.IntersectionObserver = NoopIntersectionObserver;
    installedObserver = true;
  }
  live = false;
  starts = [];
  startFails = false;
  attached = [];
  kills = [];
  stubReviewApi({
    startReviewClaudeSession: async (ws) => {
      starts.push(ws);
      if (startFails) throw new Error("the configured agent is not Claude Code");
      live = true;
      return { sessionId: `review-claude:${ws}`, prIds: ["pr1"] };
    },
  });
  stubPtyApi({
    ptyExists: async () => live,
    attachPty: async (id: string) => {
      attached.push(id);
      return { scrollback: [], endOffset: 0 };
    },
    resizePty: async () => {},
    writePty: async () => {},
    killPty: async (id: string) => {
      kills.push(id);
      live = false;
    },
    onPtyOutput: async () => () => {},
    onPtyExit: async () => () => {},
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

afterAll(() => {
  // Another file asserts on its absence, which is `useExpandOnApproach`'s feature-detect.
  if (installedObserver) globalWithObserver.IntersectionObserver = undefined;
  resetReviewApi();
  resetPtyApi();
});

const buttonNamed = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

describe("ClaudeTab", () => {
  it("starts a session when none is running, then attaches to it", async () => {
    const m = await mountForInteraction(createElement(ClaudeTab, { ctx: ctxFor(pr) }));
    mounted = m;
    await waitFor(() => attached.length > 0, "the terminal to attach");
    expect(starts).toEqual(["ws"]);
    expect(attached).toEqual(["review-claude:ws"]);
    expect(textOf(m.host.innerHTML)).toContain("Read-only");
  });

  it("attaches to a running session without starting another", async () => {
    live = true;
    mounted = await mountForInteraction(createElement(ClaudeTab, { ctx: ctxFor(pr) }));
    await waitFor(() => attached.length > 0, "the terminal to attach");
    expect(starts).toEqual([]);
  });

  it("shows why a start failed, and never attaches a plain shell", async () => {
    startFails = true;
    const m = await mountForInteraction(createElement(ClaudeTab, { ctx: ctxFor(pr) }));
    mounted = m;
    await waitFor(() => textOf(m.host.innerHTML).includes("not Claude Code"), "the error");
    expect(textOf(m.host.innerHTML)).toContain("Retry");
    expect(attached).toEqual([]);
  });

  it("retries a failed start", async () => {
    startFails = true;
    const m = await mountForInteraction(createElement(ClaudeTab, { ctx: ctxFor(pr) }));
    mounted = m;
    await waitFor(() => textOf(m.host.innerHTML).includes("Retry"), "the Retry button");
    startFails = false;
    buttonNamed(m.host, "Retry")?.click();
    await waitFor(() => attached.length > 0, "the terminal to attach");
    expect(starts).toEqual(["ws", "ws"]);
  });

  it("restart ends the session and starts a new one", async () => {
    live = true;
    const m = await mountForInteraction(createElement(ClaudeTab, { ctx: ctxFor(pr) }));
    mounted = m;
    await waitFor(() => attached.length === 1, "the first attach");
    buttonNamed(m.host, "Restart")?.click();
    await waitFor(() => attached.length === 2, "the terminal to reattach");
    expect(kills).toEqual(["review-claude:ws"]);
    expect(starts).toEqual(["ws"]);
    expect(attached).toEqual(["review-claude:ws", "review-claude:ws"]);
  });

  it("waits for the checkout before starting anything", async () => {
    const pending = { ...pr, worktreeStatus: "checking-out" } as ReviewWorkspacePr;
    const m = await mountForInteraction(createElement(ClaudeTab, { ctx: ctxFor(pending) }));
    mounted = m;
    expect(textOf(m.host.innerHTML)).toContain("starts once the PR is checked out");
    expect(starts).toEqual([]);
    expect(attached).toEqual([]);
  });
});
