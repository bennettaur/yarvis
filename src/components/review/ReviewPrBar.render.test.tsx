import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail, PrRef } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetReviewApi, stubReviewApi } from "../../test/reviewWorkspacesApi";
import { prColor } from "./prColors";
import ReviewPrBar from "./ReviewPrBar";
import type { StaticTabKind } from "./tabs/types";

const ref: PrRef = { provider: "github", owner: "acme", repo: "widgets", number: 7 };
const pr = { id: "pr1", ref, title: "Teach the parser tabs", status: "ready" } as ReviewWorkspacePr;

const detail = (over: Partial<PrDetail> = {}) =>
  ({
    title: "Teach the parser tabs",
    state: "OPEN",
    draft: false,
    author: "octo",
    checks: [],
    mergeable: "UNKNOWN",
    mergeMethods: [],
    reviewers: [],
    reviewThreads: [],
    fromFork: false,
    ...over,
  }) as PrDetail;

let opened: StaticTabKind[] = [];
let changed = 0;
let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
  opened = [];
  changed = 0;
});

async function mount(readOnly = false, over: Partial<PrDetail> = {}) {
  primeCache(prDetailKey(ref), detail(over));
  const mounted = await mountForInteraction(
    createElement(ReviewPrBar, {
      workspaceId: "ws",
      pr,
      color: prColor(0),
      readOnly,
      openTab: (kind) => opened.push(kind),
      onChanged: () => {
        changed++;
      },
    }),
  );
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  );

describe("ReviewPrBar", () => {
  it("offers the review actions the PR's state allows", async () => {
    const open = await mount();
    expect(button(open, "Approve")).toBeDefined();
    expect(button(open, "Request changes")).toBeDefined();
    unmount();
    const draft = await mount(false, { draft: true });
    expect(button(draft, "Ready for review")).toBeDefined();
    expect(button(draft, "Approve")).toBeUndefined();
  });

  it("opens the guided review and verification tabs", async () => {
    const host = await mount();
    button(host, "Guided review")?.click();
    button(host, "Verification")?.click();
    expect(opened).toEqual(["guide", "verification"]);
  });

  it("leaves the checkout's controls off an archived workspace", async () => {
    const host = await mount(true);
    expect(button(host, "More for this PR")).toBeUndefined();
  });

  it("asks before removing the PR, then removes it once", async () => {
    const removed: string[] = [];
    stubReviewApi({
      removeReviewPr: async (_ws, prId) => {
        removed.push(prId);
      },
    });
    const host = await mount();
    button(host, "More for this PR")?.click();
    await waitFor(() => button(host, "Remove from workspace") !== undefined, "the menu");
    button(host, "Remove from workspace")?.click();
    await waitFor(() => button(host, "Remove") !== undefined, "the confirmation");
    expect(removed).toEqual([]);
    button(host, "Remove")?.click();
    await waitFor(() => changed > 0, "the workspace to be re-read");
    expect(removed).toEqual(["pr1"]);
    expect(changed).toBe(1);
  });

  it("puts a conflict with the PR's base, and the way to resolve it, on the bar", async () => {
    const host = await mount(false, {
      mergeable: "CONFLICTING",
      hasConflicts: true,
      baseRef: "main",
    });
    expect(host.textContent).toContain("Conflicts with main");
    expect(button(host, "Resolve conflicts")).toBeDefined();
  });

  it("leaves a PR whose mergeability is unknown as it was", async () => {
    const host = await mount();
    expect(host.textContent).not.toContain("Conflicts with");
    expect(button(host, "Resolve conflicts")).toBeUndefined();
  });
});
