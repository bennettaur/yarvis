import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { WorkspaceRepoDetail } from "../../lib/workspaces";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import WorkspacePrStatus, { DetectPrsButton } from "./WorkspacePrStatus";

interface SentRequest {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

const sent: SentRequest[] = [];
let replies: Record<string, { status: number; body: unknown }> = {};

// The transport is stubbed rather than lib/workspaces, so the paths and bodies
// that client builds stay under test.
stubSidecarApi({
  getHealth: async () => ({
    status: "ok",
    service: "sidecar",
    uptimeMs: 0,
    ready: true,
    phase: "ready" as const,
  }),
  waitForSidecarReady: async () => {},
  getStatus: async () => ({
    service: "sidecar",
    databaseConfigured: true,
    providers: { anthropic: false, gemini: false, cerebras: false, huggingface: false },
  }),
  getDbHealth: async () => ({ configured: true, reachable: true }),
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    sent.push({
      path,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    const reply = Object.entries(replies).find(([suffix]) => path.endsWith(suffix))?.[1];
    // The status line's sync poll answers "in sync" unless a test says otherwise.
    const fallback = path.endsWith("/sync")
      ? { ahead: 0, behind: 0, baseBehind: 0, hasRemote: true }
      : null;
    return new Response(JSON.stringify(reply?.body ?? fallback), { status: reply?.status ?? 200 });
  },
  streamSSE: async function* () {},
});

const repo: WorkspaceRepoDetail = {
  id: "wr-1",
  workspaceId: "ws-1",
  repoId: "r-1",
  status: "ready",
  branch: "topic",
  existingBranch: true,
  baseBranch: "main",
  worktreePath: "/ws/widget",
  setupLog: null,
  setupExitCode: null,
  error: null,
  createdAt: "2026-01-01T00:00:00Z",
  repo: {
    id: "r-1",
    name: "widget",
    owner: "acme",
    repo: "widget",
    cloneUrl: "git@github.com:acme/widget.git",
    defaultBranch: "main",
    primaryClonePath: "/clones/widget",
    setupScript: null,
    runScript: null,
    pullIssues: false,
    tracker: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  pr: null,
};

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let unmount = () => {};
let changed = 0;

beforeEach(() => {
  sent.length = 0;
  replies = {};
  changed = 0;
});

afterEach(() => unmount());

afterAll(resetSidecarApi);

async function mountStatus() {
  const mounted = await mountForInteraction(
    createElement(WorkspacePrStatus, {
      workspaceId: "ws-1",
      repo,
      showRepoName: false,
      onPrLinked: () => changed++,
    }),
  );
  unmount = mounted.unmount;
  return mounted.host;
}

describe("WorkspacePrStatus", () => {
  it("links a PR by number, with or without its #", async () => {
    replies = { "/repos/wr-1/pr": { status: 200, body: { pr: {} } } };
    const host = await mountStatus();

    button(host, "Link PR")?.click();
    await waitFor(() => host.querySelector("input") !== null, "the number field");
    type(host.querySelector("input") as HTMLInputElement, "#42");
    await waitFor(() => button(host, "Link")?.disabled === false, "the Link button to enable");
    button(host, "Link")?.click();

    await waitFor(() => changed === 1, "the workspace to be re-read");
    expect(sent.find((r) => r.method === "PUT")).toEqual({
      path: "/api/workspaces/ws-1/repos/wr-1/pr",
      method: "PUT",
      body: { number: 42 },
    });
    expect(button(host, "Link PR")).toBeDefined();
  });

  it("shows why a link was refused and keeps the field open", async () => {
    replies = {
      "/repos/wr-1/pr": { status: 400, body: { error: "widget has no pull request #42" } },
    };
    const host = await mountStatus();

    button(host, "Link PR")?.click();
    await waitFor(() => host.querySelector("input") !== null, "the number field");
    type(host.querySelector("input") as HTMLInputElement, "42");
    await waitFor(() => button(host, "Link")?.disabled === false, "the Link button to enable");
    button(host, "Link")?.click();

    await waitFor(() => host.querySelector("[role=alert]") !== null, "the refusal");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("no pull request #42");
    expect(host.querySelector("input")).not.toBeNull();
    expect(changed).toBe(0);
  });

  it("won't send a number that isn't a PR number", async () => {
    const host = await mountStatus();
    button(host, "Link PR")?.click();
    await waitFor(() => host.querySelector("input") !== null, "the number field");
    type(host.querySelector("input") as HTMLInputElement, "abc");
    await waitFor(() => button(host, "Link") !== undefined, "the Link button");
    expect(button(host, "Link")?.disabled).toBe(true);
  });
});

describe("DetectPrsButton", () => {
  async function mountDetect() {
    const mounted = await mountForInteraction(
      createElement(DetectPrsButton, { workspaceId: "ws-1", onDetected: () => changed++ }),
    );
    unmount = mounted.unmount;
    return mounted.host;
  }

  it("says how many repos it found a PR for", async () => {
    replies = {
      "/prs/detect": {
        status: 200,
        body: {
          repos: [
            { workspaceRepoId: "wr-1", branch: "topic", prNumber: 5, prUrl: "u" },
            { workspaceRepoId: "wr-2", branch: null, prNumber: null, prUrl: null },
          ],
        },
      },
    };
    const host = await mountDetect();

    button(host, "Detect PRs again")?.click();

    await waitFor(() => host.querySelector("[role=status]") !== null, "the result");
    expect(host.querySelector("[role=status]")?.textContent).toBe("Found 1 of 2");
    expect(sent).toEqual([{ path: "/api/workspaces/ws-1/prs/detect", method: "POST", body: null }]);
    expect(changed).toBe(1);
  });

  it("says when no token can read the repos", async () => {
    replies = { "/prs/detect": { status: 200, body: { repos: [] } } };
    const host = await mountDetect();

    button(host, "Detect PRs again")?.click();

    await waitFor(() => host.querySelector("[role=status]") !== null, "the result");
    expect(host.querySelector("[role=status]")?.textContent).toContain(
      "No GitHub or Azure DevOps token",
    );
  });
});
