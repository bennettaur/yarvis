import { beforeEach, describe, expect, it, mock } from "bun:test";
import { renderToHtml } from "../test/render";
import WorkspacesPanel from "./WorkspacesPanel";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

mock.module("../lib/api", () => ({
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
  // Faithful copy of the real implementation: a naive stub here would leak
  // into any other test file that runs in the same process (`mock.module` is
  // process-global, not file-scoped) and break its assertions about the
  // actual error-detail-extraction behavior.
  ensureOk: async (res: Response, context: string) => {
    if (res.ok) return;
    let raw = "";
    try {
      raw = (await res.text()).trim();
    } catch {
      // no body to read
    }
    let detail: string | null = null;
    if (raw) {
      try {
        const body = JSON.parse(raw) as { error?: unknown };
        const err = body?.error;
        if (typeof err === "string") {
          detail = err;
        } else if (err && typeof err === "object") {
          const flat = err as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
          const parts: string[] = [];
          if (Array.isArray(flat.formErrors)) parts.push(...flat.formErrors);
          for (const [field, msgs] of Object.entries(flat.fieldErrors ?? {})) {
            if (Array.isArray(msgs) && msgs.length) parts.push(`${field}: ${msgs.join(", ")}`);
          }
          if (parts.length) detail = parts.join("; ");
        }
        if (detail === null) detail = raw;
      } catch {
        detail = raw;
      }
    }
    throw new Error(
      detail ? `${context} failed (${res.status}): ${detail}` : `${context} failed: ${res.status}`,
    );
  },
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
  sidecarFetch: async (path: string) => {
    if (path === "/api/workspaces") return json([EXISTING]);
    if (path === `/api/workspaces/${JUST_CREATED.id}`) return json(JUST_CREATED);
    if (path.startsWith("/api/workspaces/ws-missing")) return json({ error: "not found" }, 404);
    return json([]);
  },
  // The attention store subscribes to an SSE stream; an empty one keeps it quiet.
  streamSSE: async function* () {},
}));

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

  it("drops the selection when the workspace really is gone", async () => {
    const html = await renderToHtml(<WorkspacesPanel requested={{ id: "ws-missing" }} />);

    expect(html).toContain(EMPTY_STATE);
  });
});
