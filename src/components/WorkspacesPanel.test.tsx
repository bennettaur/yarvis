import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { WorkspaceSummary } from "../lib/workspaces";
import { nativeInvoke } from "../test/nativeInvoke";
import { mountForInteraction, renderToHtml } from "../test/render";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";

const EXISTING = {
  id: "ws-old",
  name: "Rename the API",
  slug: "rename-the-api",
  status: "active",
  rootPath: "/tmp/ws-old",
  summary: null,
  mergedPrUrl: null,
  error: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-01T09:00:00.000Z",
  archivedAt: null,
  repoNames: ["web"],
  prs: [
    {
      repoName: "web",
      prNumber: 12,
      prState: "open",
      isDraft: false,
      mergeable: "clean",
      checkRollup: "failure",
      reviewDecision: "review_required",
    },
  ],
};

// A workspace created after the panel last fetched its list: reachable by id but
// absent from `/api/workspaces` until the next refresh.
const JUST_CREATED = {
  ...EXISTING,
  id: "ws-new",
  name: "Fix the focus bug",
  slug: "fix-the-focus-bug",
  rootPath: "/tmp/ws-new",
  repos: [],
  tasks: [],
  issues: [],
};

const WEB_REPO = {
  id: "wr-web",
  workspaceId: "ws-archiving",
  repoId: "repo-web",
  status: "ready",
  branch: "feature",
  existingBranch: false,
  baseBranch: "main",
  worktreePath: "/tmp/ws-archiving/web",
  setupLog: null,
  setupExitCode: null,
  error: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  repo: {
    id: "repo-web",
    name: "web",
    owner: "octo",
    repo: "web",
    cloneUrl: "https://github.com/octo/web.git",
    defaultBranch: "main",
    primaryClonePath: "/tmp/web",
    setupScript: null,
    runScript: null,
    pullIssues: false,
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-06-01T09:00:00.000Z",
  },
  pr: null,
};

// An archive whose teardown is still deleting the worktrees.
const ARCHIVING = {
  ...JUST_CREATED,
  id: "ws-archiving",
  name: "Archive in flight",
  status: "archiving",
  error: null,
  repos: [WEB_REPO],
};

// An archive that stopped on a worktree with uncommitted work.
const ARCHIVE_STOPPED = {
  ...ARCHIVING,
  id: "ws-archive-stopped",
  name: "Archive stopped",
  error: "one or more worktrees could not be removed",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      writes.push({ path, method: init.method });
      return json({ ok: true });
    }
    if (path === "/api/workspaces") return json([EXISTING]);
    if (path === `/api/workspaces/${JUST_CREATED.id}`) return json(JUST_CREATED);
    if (path === `/api/workspaces/${ARCHIVING.id}`) return json(ARCHIVING);
    if (path === `/api/workspaces/${ARCHIVE_STOPPED.id}`) return json(ARCHIVE_STOPPED);
    if (path.startsWith("/api/workspaces/ws-missing")) return json({ error: "not found" }, 404);
    return json([]);
  },
  // The attention store subscribes to an SSE stream; an empty one keeps it quiet.
  streamSSE: async function* () {},
});

/** Sidecar calls other than reads, which is what a user action sends. */
let writes: { path: string; method: string }[] = [];

// The agent tab shows only while the core reports its session alive.
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: { id?: string }) =>
    command === "pty_exists" ? args?.id === `ws-claude:${JUST_CREATED.id}` : nativeInvoke(command),
}));

// Imported after the mock so the panel binds to it.
const { default: WorkspacesPanel, groupWorkspaces } = await import("./WorkspacesPanel");

const EMPTY_STATE = "Select a workspace or create a new one";

describe("WorkspacesPanel", () => {
  // The panel persists its selection, so each test starts from a clean slate.
  beforeEach(() => localStorage.clear());

  it("keeps a just-created workspace selected even though the list predates it", async () => {
    const html = await renderToHtml(<WorkspacesPanel requested={{ id: JUST_CREATED.id }} />);

    expect(html).not.toContain(EMPTY_STATE);
    // The detail view for the new workspace is on screen, not just its list row.
    expect(html).toContain(JUST_CREATED.name);
  });

  it("flags the PR state on the list row, beside the workspace status", async () => {
    const html = await renderToHtml(<WorkspacesPanel />);

    expect(html).toContain("web #12 checks failing");
  });

  it("hides the right column while an archive is deleting the worktrees", async () => {
    const html = await renderToHtml(<WorkspacesPanel requested={{ id: ARCHIVING.id }} />);

    expect(html).toContain("Removing worktrees…");
    expect(html).not.toContain("All files");
  });

  it("keeps the right column for an archive stopped on a dirty worktree", async () => {
    const html = await renderToHtml(<WorkspacesPanel requested={{ id: ARCHIVE_STOPPED.id }} />);

    expect(html).not.toContain("Removing worktrees…");
    expect(html).toContain("All files");
  });

  it("drops the selection when the workspace really is gone", async () => {
    const html = await renderToHtml(<WorkspacesPanel requested={{ id: "ws-missing" }} />);

    expect(html).toContain(EMPTY_STATE);
  });
});

describe("WorkspacesPanel agent tab", () => {
  let unmount: (() => void) | null = null;
  const globalWithObserver = globalThis as { IntersectionObserver?: unknown };
  const hadObserver = "IntersectionObserver" in globalWithObserver;

  beforeEach(() => {
    localStorage.clear();
    writes = [];
    // xterm builds one when the agent tab's terminal opens, and happy-dom has none.
    globalWithObserver.IntersectionObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    if (!hadObserver) delete globalWithObserver.IntersectionObserver;
  });

  it("ends the agent's registration in the sidecar when the user closes its tab", async () => {
    const mounted = await mountForInteraction(
      <WorkspacesPanel requested={{ id: JUST_CREATED.id }} />,
      200,
    );
    unmount = mounted.unmount;
    const close = mounted.host.querySelector<HTMLButtonElement>('[aria-label="End Claude"]');
    expect(close).not.toBeNull();

    close?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Without this the sidecar resumes the closed session on the next start.
    expect(writes).toContainEqual({
      path: `/api/workspaces/${JUST_CREATED.id}/agent/stop`,
      method: "POST",
    });
  });
});

describe("groupWorkspaces", () => {
  const summary = (id: string, repoNames: string[]) =>
    ({ ...EXISTING, id, repoNames, prs: [] }) as WorkspaceSummary;

  it("puts multi-repo workspaces holding the same repos in one group", () => {
    const groups = groupWorkspaces([
      summary("ws-a", ["femr", "llm-service"]),
      summary("ws-b", ["llm-service", "femr"]),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("femr + llm-service");
    expect(new Set(groups[0]?.items.map((w) => w.id))).toEqual(new Set(["ws-a", "ws-b"]));
  });

  it("keeps multi-repo workspaces holding different repos in separate groups", () => {
    const groups = groupWorkspaces([
      summary("ws-a", ["femr", "llm-service"]),
      summary("ws-c", ["femr", "web"]),
    ]);

    expect(groups.map((g) => g.label)).toEqual(["femr + llm-service", "femr + web"]);
  });

  it("orders single-repo groups before multi-repo groups, each by label", () => {
    const items = [
      summary("ws-zebra", ["zebra", "alpha"]),
      summary("ws-beta", ["beta", "alpha"]),
      summary("ws-single", ["web"]),
      summary("ws-scratch", []),
    ];

    const labels = (list: WorkspaceSummary[]) => groupWorkspaces(list).map((g) => g.label);

    expect(labels(items)).toEqual(["Scratch", "web", "alpha + beta", "alpha + zebra"]);
    // Group order must not follow the list's arrival order, or it would shuffle
    // between the panel's periodic refetches.
    expect(labels([...items].reverse())).toEqual(labels(items));
  });
});

afterAll(resetSidecarApi);
