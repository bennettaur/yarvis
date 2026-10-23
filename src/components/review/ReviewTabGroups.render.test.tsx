import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement, useState } from "react";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail, PrRef } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { mountForInteraction } from "../../test/render";
import ReviewTabGroups, { tabPanelId } from "./ReviewTabGroups";
import {
  closeTab,
  emptyLayout,
  moveActiveToOtherGroup,
  openTab,
  type TabLayout,
} from "./tabs/tabLayout";
import type { TabContext } from "./tabs/types";

const ref = (number: number): PrRef => ({ provider: "github", owner: "o", repo: "r", number });
const ctxFor = (prId: string): TabContext => ({
  workspaceId: "ws",
  pr: { id: prId, ref: ref(prId === "a" ? 1 : 2) } as ReviewWorkspacePr,
  prRef: ref(prId === "a" ? 1 : 2),
  diffMode: "split",
  openTab: () => {},
  openSetup: () => {},
});
const contexts = { a: ctxFor("a"), b: ctxFor("b") };

let change: (fn: (l: TabLayout) => TabLayout) => void = () => {};

function Harness({ initial }: { initial: TabLayout }) {
  const [layout, setLayout] = useState(initial);
  change = (fn) => setLayout(fn);
  return createElement(ReviewTabGroups, {
    layout,
    onChange: setLayout,
    contextFor: (prId: string) => contexts[prId as "a" | "b"] ?? null,
    ownerOf: () => null,
    showOwner: false,
    empty: null,
  });
}

let unmount = () => {};
afterEach(() => unmount());

describe("ReviewTabGroups", () => {
  it("keeps a tab's body mounted when the view splits and when it folds", async () => {
    for (const n of [1, 2]) {
      primeCache(prDetailKey(ref(n)), { reviewers: [] } as unknown as PrDetail);
    }
    const initial = [
      { kind: "reviewers" as const, prId: "a" },
      { kind: "reviewers" as const, prId: "b" },
    ].reduce((l, spec) => openTab(l, spec), emptyLayout());
    const mounted = await mountForInteraction(createElement(Harness, { initial }));
    unmount = mounted.unmount;
    const panel = (id: string) => mounted.host.querySelector(`#${tabPanelId(id)}`);

    const stays = panel("reviewers:a");
    expect(stays).not.toBeNull();
    // Splitting moves b to a second group; a's group must not be rebuilt.
    await act(async () => change(moveActiveToOtherGroup));
    expect(panel("reviewers:a")).toBe(stays);

    // Closing a folds the first group away; b's group, now alone, must survive.
    const survivor = panel("reviewers:b");
    expect(survivor).not.toBeNull();
    await act(async () => change((l) => closeTab(l, "reviewers:a")));
    expect(panel("reviewers:b")).toBe(survivor);
    expect(survivor?.isConnected).toBe(true);
  });
});
