import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import * as api from "../../../lib/api";
import { prDetailKey } from "../../../lib/pr/cache";
import type { PrDetail, PrRef } from "../../../lib/pr/types";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewChangedFiles, ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import type { LatestVerification } from "../../../lib/reviewWorkspaces/verification";
import { mountForInteraction, textOf } from "../../../test/render";
import { reviewThread } from "../../../test/reviewThread";
import { changedFilesKey, reviewViewedKey, verificationKey } from "../tabs/reviewData";
import type { TabSpec } from "../tabs/types";
import ChangedFilesTree from "./ChangedFilesTree";

const ref: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 7 };
const pr = {
  id: "pr1",
  ref,
  headSha: "h".repeat(40),
  mergeBaseSha: "b".repeat(40),
} as ReviewWorkspacePr;
const color = { name: "sky", bg: "bg-sky-500", border: "border-sky-500", text: "text-sky-400" };

const written: { path: string; body: string }[] = [];
// Only the transport is stubbed; a spy rather than `mock.module`, which would
// answer for every file loaded after this one.
const sidecarFetch = spyOn(api, "sidecarFetch").mockImplementation(async (path, init) => {
  written.push({ path, body: String(init?.body ?? "") });
  return new Response("{}", { status: 200 });
});
afterAll(() => sidecarFetch.mockRestore());

let unmount = () => {};
afterEach(() => {
  unmount();
  written.length = 0;
});

function prime() {
  const changed: ReviewChangedFiles = {
    headSha: pr.headSha ?? "",
    mergeBaseSha: pr.mergeBaseSha ?? "",
    files: [
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
      { path: "src/b.ts", status: "added", additions: 9, deletions: 0, binary: false },
    ],
  };
  primeCache(changedFilesKey(pr) ?? "", changed);
  primeCache(reviewViewedKey(ref), ["src/b.ts"]);
  primeCache(prDetailKey(ref), {
    reviewThreads: [reviewThread({ path: "src/a.ts", bodies: ["one", "two"] })],
  } as unknown as PrDetail);
  const run = {
    status: "succeeded",
    result: { mustRead: [{ path: "src/a.ts", reason: "the core change" }] },
  } as never;
  const latest: LatestVerification = {
    headSha: pr.headSha,
    current: true,
    run,
    lastSucceeded: { run, headSha: pr.headSha, current: true },
    size: null,
  };
  primeCache(verificationKey(pr.id), latest);
}

describe("ChangedFilesTree", () => {
  it("shows viewed state, must-reads and comment counts, and opens a diff", async () => {
    prime();
    const opened: TabSpec[] = [];
    const mounted = await mountForInteraction(
      createElement(ChangedFilesTree, {
        workspaceId: "ws",
        pr,
        color,
        activePath: null,
        openTab: (spec) => opened.push(spec),
      }),
    );
    unmount = mounted.unmount;
    const html = mounted.host.innerHTML;
    expect(textOf(html)).toContain("1/2 viewed");
    expect(html).toContain("Must read: the core change");
    expect(html).toContain("2 comments, unresolved");

    const row = [...mounted.host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("a.ts"),
    );
    row?.click();
    expect(opened).toEqual([{ kind: "diff", prId: "pr1", path: "src/a.ts" }]);
  });

  it("marks a file viewed for every view of the PR at once and saves it", async () => {
    prime();
    const tree = () =>
      createElement(ChangedFilesTree, {
        workspaceId: "ws",
        pr,
        color,
        activePath: null,
        openTab: () => {},
      });
    const first = await mountForInteraction(tree());
    const second = await mountForInteraction(tree());
    unmount = () => {
      first.unmount();
      second.unmount();
    };
    const box = first.host.querySelector<HTMLInputElement>(
      'input[aria-label="Mark src/a.ts viewed"]',
    );
    box?.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(textOf(second.host.innerHTML)).toContain("2/2 viewed");
    expect(written.some((w) => w.path.endsWith("/viewed") && w.body.includes("src/a.ts"))).toBe(
      true,
    );
  });
});
