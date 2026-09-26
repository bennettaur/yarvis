import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { PrDetail, PrSummary } from "../../lib/pr/types";
import { mountForInteraction, renderToHtml, textOf } from "../../test/render";
import PrFloatingHeader from "./PrFloatingHeader";

// The header renders PrWorkspaceAction, which calls sidecarFetch to look up a
// linked workspace. Stub it to report "no workspace" so it falls back to the
// start-workspace button and the merge controls are the only variable under test.
mock.module("../../lib/api", () => ({
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
  sidecarFetch: async () => new Response("null", { status: 200 }),
  streamSSE: () => () => {},
}));

const summary = (overrides: Partial<PrSummary> = {}): PrSummary => ({
  ref: { provider: "github", owner: "octo", repo: "repo", number: 1 },
  title: "Add a thing",
  url: "https://example/p/1",
  author: "me",
  draft: false,
  state: "open",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const detail = (overrides: Partial<PrDetail> = {}): PrDetail => ({
  number: 1,
  title: "Add a thing",
  body: "",
  state: "open",
  draft: false,
  author: "me",
  baseRef: "main",
  headRef: "feat",
  fromFork: false,
  headSha: "",
  additions: 0,
  deletions: 0,
  mergeable: "MERGEABLE",
  mergeMethods: ["MERGE", "SQUASH", "REBASE"],
  autoMergeEnabled: false,
  canEnableAutoMerge: false,
  canDisableAutoMerge: false,
  checks: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", url: null }],
  reviewThreads: [],
  reviewers: [],
  ...overrides,
});

const render = (d: PrDetail | null, starred = false) =>
  renderToHtml(
    createElement(PrFloatingHeader, {
      pr: summary(),
      detail: d,
      onBack: () => {},
      starred,
      onToggleStar: async () => {},
    }),
  );

describe("PrFloatingHeader merge controls", () => {
  it("shows Merge (not Enable auto-merge) once the PR is ready to merge", async () => {
    const html = await render(detail());
    expect(html).toContain("Merge");
    expect(html).not.toContain("Enable auto-merge");
    expect(html).not.toContain("Auto-merge on");
  });

  it("shows Enable auto-merge when the PR isn't mergeable yet but the viewer may arm it", async () => {
    const html = await render(detail({ mergeable: "CONFLICTING", canEnableAutoMerge: true }));
    expect(html).toContain("Enable auto-merge");
  });

  it("shows the badge and Cancel auto-merge once auto-merge is armed", async () => {
    const html = await render(detail({ autoMergeEnabled: true, canDisableAutoMerge: true }));
    expect(html).toContain("Auto-merge on");
    expect(html).toContain("Cancel auto-merge");
    expect(html).not.toContain(">Merge<");
  });

  it("shows no merge controls when the repo exposes no merge methods (e.g. Azure)", async () => {
    const html = await render(detail({ mergeMethods: [], canEnableAutoMerge: true }));
    expect(html).not.toContain("Merge");
    expect(html).not.toContain("Enable auto-merge");
  });

  it("shows no merge controls on a merged PR", async () => {
    const html = await render(detail({ state: "MERGED" }));
    expect(html).not.toContain("Enable auto-merge");
    expect(html).not.toContain("Auto-merge on");
  });
});

describe("PrFloatingHeader loading state", () => {
  // A stack layer swaps the pull request instantly and then waits on a provider
  // round trip. The summary already carries a title, so the only sign the page
  // is mid-navigation is this indicator (#268).
  it("says it is loading while the detail is on its way", async () => {
    const html = await renderToHtml(
      createElement(PrFloatingHeader, {
        pr: summary(),
        detail: null,
        loading: true,
        onBack: () => {},
        starred: false,
        onToggleStar: async () => {},
      }),
    );

    expect(textOf(html)).toContain("Loading…");
    expect(html).toContain('aria-busy="true"');
  });

  it("says nothing once the detail has landed", async () => {
    const html = await render(detail());

    expect(textOf(html)).not.toContain("Loading…");
  });
});

describe("PrFloatingHeader star", () => {
  it("offers to star a PR that isn't starred", async () => {
    const html = await render(detail());

    expect(html).toContain('title="Star"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("offers to unstar a starred PR", async () => {
    const html = await render(detail(), true);

    expect(html).toContain('title="Unstar"');
    expect(html).toContain('aria-pressed="true"');
  });
});

describe("PrFloatingHeader star toggle", () => {
  const starButton = (host: HTMLElement) =>
    host.querySelector("button[aria-pressed]") as HTMLButtonElement;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("stars with the detail's title when the summary has none", async () => {
    // Summaries from the workspace poller cache carry no title.
    const calls: [PrSummary, boolean][] = [];
    const { host, unmount } = await mountForInteraction(
      createElement(PrFloatingHeader, {
        pr: summary({ title: "" }),
        detail: detail({ title: "Real title" }),
        onBack: () => {},
        starred: false,
        onToggleStar: async (pr, starred) => {
          calls.push([pr, starred]);
        },
      }),
    );

    starButton(host).click();
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].title).toBe("Real title");
    expect(calls[0]?.[1]).toBe(false);
    unmount();
  });

  it("shows the error and re-enables the star when the toggle fails", async () => {
    const { host, unmount } = await mountForInteraction(
      createElement(PrFloatingHeader, {
        pr: summary(),
        detail: detail(),
        onBack: () => {},
        starred: true,
        onToggleStar: async () => {
          throw new Error("star failed");
        },
      }),
    );

    starButton(host).click();
    await settle();

    expect(host.textContent).toContain("star failed");
    expect(starButton(host).disabled).toBe(false);
    unmount();
  });
});
