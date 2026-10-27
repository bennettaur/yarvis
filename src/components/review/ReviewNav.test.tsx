import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { changedFilesKey } from "../../lib/reviewWorkspaces/cache";
import { renderToHtml } from "../../test/render";
import { PR_COLORS, prColor } from "./prColors";
import ReviewNav, { cloneStatusText, navGroups, prLabel } from "./ReviewNav";

const pr = (over: Partial<ReviewWorkspacePr> = {}): ReviewWorkspacePr => ({
  id: "pr-1",
  workspaceId: "ws-1",
  refKey: "gh:acme/widgets/7",
  ref: { provider: "github", owner: "acme", repo: "widgets", number: 7 },
  title: "Teach the parser about tabs",
  author: "octo",
  headRef: "tabs",
  baseRef: "main",
  colorIndex: 0,
  position: 0,
  status: "ready",
  error: null,
  worktreePath: "/tmp/x",
  worktreeStatus: "ready",
  headSha: "abc",
  baseSha: "def",
  mergeBaseSha: "def",
  setupConsent: null,
  setupStatus: null,
  setupLog: null,
  addedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("prColor", () => {
  it("is fixed by colour index and wraps past the palette", () => {
    expect(prColor(0)).toBe(PR_COLORS[0]!);
    expect(prColor(1)).not.toBe(prColor(0));
    expect(prColor(PR_COLORS.length)).toBe(PR_COLORS[0]!);
  });

  it("gives every colour a distinct name and full class names Tailwind can find", () => {
    expect(new Set(PR_COLORS.map((c) => c.name)).size).toBe(PR_COLORS.length);
    for (const c of PR_COLORS) {
      expect(c.bg).toBe(`bg-${c.name}-400`);
      expect(c.border).toBe(`border-${c.name}-400`);
      expect(c.text).toBe(`text-${c.name}-300`);
    }
  });
});

describe("navGroups", () => {
  it("orders PRs by position and keeps each one's own colour", () => {
    const groups = navGroups([
      pr({ id: "b", position: 1, colorIndex: 3 }),
      pr({ id: "a", position: 0, colorIndex: 1 }),
    ]);
    expect(groups.map((g) => g.pr.id)).toEqual(["a", "b"]);
    expect(groups.map((g) => g.color)).toEqual([prColor(1), prColor(3)]);
  });
});

describe("cloneStatusText", () => {
  it("says nothing once the checkout is ready", () => {
    expect(cloneStatusText(pr(), null)).toBeNull();
  });

  it("shows the clone's latest line while it runs, and failures", () => {
    expect(cloneStatusText(pr({ status: "cloning" }), "Receiving objects: 40%")).toBe(
      "Cloning · Receiving objects: 40%",
    );
    expect(cloneStatusText(pr({ status: "pending" }), null)).toBe("Waiting to clone…");
    expect(cloneStatusText(pr({ status: "error", error: "auth failed" }), null)).toBe(
      "auth failed",
    );
    expect(cloneStatusText(pr({ worktreeStatus: "checking-out" }), null)).toBe("Checking out…");
  });
});

describe("ReviewNav", () => {
  // What the nav reads comes from the cache, primed here, so nothing in it
  // depends on what the sidecar client answers in this process.
  const render = (prs: ReviewWorkspacePr[]) => {
    for (const p of prs) {
      primeCache(prDetailKey(p.ref), { title: p.title, reviewThreads: [] } as unknown as PrDetail);
      const key = changedFilesKey(p);
      if (key) primeCache(key, { headSha: p.headSha, mergeBaseSha: p.mergeBaseSha, files: [] });
    }
    return renderToHtml(
      createElement(ReviewNav, {
        workspaceId: "ws-1",
        prs,
        active: { kind: "description", prId: "b" },
        progress: new Map([["b", "Receiving objects: 40%"]]),
        openTab: () => {},
        onSetup: () => {},
      }),
    );
  };

  it("groups the sections under each PR, headed in its colour", async () => {
    const html = await render([
      pr({ id: "a", colorIndex: 0 }),
      pr({
        id: "b",
        position: 1,
        colorIndex: 2,
        status: "cloning",
        ref: { provider: "github", owner: "acme", repo: "gadgets", number: 9 },
      }),
    ]);
    const host = document.createElement("div");
    host.innerHTML = html;
    const sections = [...host.querySelectorAll("section")];
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["widgets#7", "gadgets#9"]);
    expect(sections[0]!.innerHTML).toContain(prColor(0).border);
    expect(sections[1]!.innerHTML).toContain(prColor(2).border);
    for (const s of sections) {
      for (const label of ["Description", "Reviewers", "Checks", "Comments", "Changed files"]) {
        expect(s.textContent).toContain(label);
      }
    }
    // The clone's progress shows on its own PR only.
    expect(sections[1]!.textContent).toContain("Cloning · Receiving objects: 40%");
    expect(sections[0]!.textContent).not.toContain("Cloning");
  });

  it("offers the setup prompt once the checkout is ready and nobody has answered", async () => {
    expect(await render([pr()])).toContain("Setup hasn't run");
    expect(await render([pr({ setupConsent: "declined" })])).not.toContain("Setup hasn't run");
    expect(await render([pr({ worktreeStatus: "checking-out" })])).not.toContain(
      "Setup hasn't run",
    );
  });

  it("names a PR by repo and number", () => {
    expect(prLabel(pr())).toBe("widgets#7");
    expect(
      prLabel({ ref: { provider: "azure", org: "o", project: "p", repo: "svc", prId: 12 } }),
    ).toBe("svc#12");
  });
});
