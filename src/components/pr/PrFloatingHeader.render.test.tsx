import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { PrDetail, PrSummary } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";
import PrFloatingHeader from "./PrFloatingHeader";

// The header renders PrWorkspaceLink, which calls sidecarFetch to look up a
// linked workspace. Stub it to report "no workspace" so the link renders
// nothing and the merge controls are the only variable under test.
mock.module("../../lib/api", () => ({
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

const render = (d: PrDetail | null) =>
  renderToHtml(createElement(PrFloatingHeader, { pr: summary(), detail: d, onBack: () => {} }));

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
