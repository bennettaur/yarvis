import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { changedFilesKey } from "../../lib/reviewWorkspaces/cache";
import { mountForInteraction } from "../../test/render";
import ReviewNav from "./ReviewNav";
import type { TabSpec } from "./tabs/types";

const pr = {
  id: "pr1",
  ref: { provider: "github", owner: "acme", repo: "widgets", number: 7 },
  title: "Teach the parser about tabs",
  position: 0,
  colorIndex: 0,
  status: "ready",
  worktreeStatus: "ready",
  headSha: "h".repeat(40),
  mergeBaseSha: "b".repeat(40),
  setupConsent: "declined",
  setupStatus: null,
} as ReviewWorkspacePr;

let unmount = () => {};
afterEach(() => unmount());

describe("ReviewNav", () => {
  it("opens the verification checklist and the flow diagram from the PR's items", async () => {
    primeCache(prDetailKey(pr.ref), { title: pr.title, reviewThreads: [] } as unknown as PrDetail);
    primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
    const opened: TabSpec[] = [];
    const mounted = await mountForInteraction(
      createElement(ReviewNav, {
        workspaceId: "ws",
        prs: [pr],
        active: null,
        progress: new Map(),
        openTab: (spec) => opened.push(spec),
        onSetup: () => {},
        onAddStackLayers: async () => {},
      }),
    );
    unmount = mounted.unmount;
    const item = (label: string) =>
      [...mounted.host.querySelectorAll("button")].find((b) => b.textContent === label);
    item("Verification")?.click();
    item("Flow diagram")?.click();
    expect(opened).toEqual([
      { kind: "verification", prId: "pr1" },
      { kind: "diagram", prId: "pr1" },
    ]);
  });
});
