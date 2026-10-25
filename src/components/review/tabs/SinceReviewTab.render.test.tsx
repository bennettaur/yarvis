import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrRef } from "../../../lib/pr/types";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import {
  type LastReview,
  lastReviewKey,
  type ReviewCommit,
  type SinceReview,
} from "../../../lib/reviewWorkspaces/sinceReview";
import { mountForInteraction, renderToHtml, textOf, waitFor } from "../../../test/render";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import SinceReviewTab, { markSourceText, SinceReviewView, summaryLine } from "./SinceReviewTab";
import type { TabContext, TabSpec } from "./types";

const ref: PrRef = { provider: "github", owner: "acme", repo: "widgets", number: 7 };
const sha = (c: string) => c.repeat(40);
const pr = {
  id: "pr1",
  ref,
  status: "ready",
  headSha: sha("b"),
  baseSha: sha("e"),
  mergeBaseSha: sha("e"),
} as ReviewWorkspacePr;

const opened: TabSpec[] = [];
const ctx: TabContext = {
  workspaceId: "ws",
  pr,
  prRef: ref,
  diffMode: "split",
  openTab: (spec) => opened.push(spec),
  openSetup: () => {},
};

const commit = (c: string, isNew: boolean, subject = `commit ${c}`): ReviewCommit => ({
  sha: sha(c),
  subject,
  author: "octo",
  date: "2026-10-01T00:00:00Z",
  parents: [],
  isNew,
});

const since = (over: Partial<SinceReview> = {}): SinceReview => ({
  fromHeadSha: sha("a"),
  toHeadSha: sha("b"),
  fromMergeBase: sha("e"),
  toMergeBase: sha("e"),
  rebased: false,
  baseMoved: false,
  mark: {
    headSha: sha("a"),
    baseSha: null,
    mergeBaseSha: null,
    source: "provider",
    createdAt: "2026-10-01T00:00:00Z",
  },
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      binary: false,
      tooLarge: false,
    },
    {
      path: "src/x.ts",
      status: "reverted",
      additions: 0,
      deletions: 2,
      binary: false,
      tooLarge: false,
    },
  ],
  filesTruncated: false,
  commits: [commit("2", true, "Address review"), commit("1", false, "First pass")],
  removedCommits: [],
  commitsTruncated: false,
  rebaseMatchSkipped: false,
  ...over,
});

const last: LastReview = {
  mark: since().mark,
  shaExists: true,
  headSha: sha("b"),
  upToDate: false,
};

let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
  opened.length = 0;
});

describe("summaryLine", () => {
  it("counts new commits and files, and says how the base moved", () => {
    expect(summaryLine(since())).toBe("1 new commit · 2 files changed");
    expect(summaryLine(since({ rebased: true, baseMoved: true }))).toContain(
      "rebased onto a newer base",
    );
    expect(summaryLine(since({ rebased: true }))).toContain("force-push");
    expect(summaryLine(since({ baseMoved: true }))).toContain("base branch merged in");
  });
});

describe("markSourceText", () => {
  it("names the provider for a review made there", () => {
    expect(markSourceText(since().mark, ref)).toBe("in your review on GitHub");
  });
});

describe("SinceReviewView", () => {
  it("shows the summary, the changed files and only the new commits", async () => {
    const html = await renderToHtml(
      createElement(SinceReviewView, {
        prRef: ref,
        since: since(),
        onOpenFile: () => {},
        onOpenCommit: () => {},
      }),
    );
    const text = textOf(html);
    expect(text).toContain("1 new commit · 2 files changed");
    expect(text).not.toContain("Coming soon");
    expect(text).toContain("Changed again");
    expect(text).toContain("Reverted");
    expect(text).toContain("Address review");
    expect(text).not.toContain("First pass");
  });

  it("opens a file's interdiff, pinned to the reviewed head, and a new commit", async () => {
    const mounted = await mountForInteraction(
      createElement(SinceReviewView, {
        prRef: ref,
        since: since(),
        onOpenFile: (file) =>
          ctx.openTab({ kind: "since-file", prId: "pr1", path: file.path, from: sha("a") }),
        onOpenCommit: (c) => ctx.openTab({ kind: "commit", prId: "pr1", sha: c.sha }),
      }),
    );
    unmount = mounted.unmount;
    const buttons = [...mounted.host.querySelectorAll("button")];
    buttons.find((b) => b.textContent?.includes("src/a.ts"))?.click();
    buttons.find((b) => b.textContent?.includes("Address review"))?.click();
    expect(opened).toEqual([
      { kind: "since-file", prId: "pr1", path: "src/a.ts", from: sha("a") },
      { kind: "commit", prId: "pr1", sha: sha("2") },
    ]);
  });

  it("lists commits a force-push dropped, and says when rebases weren't matched", async () => {
    const html = await renderToHtml(
      createElement(SinceReviewView, {
        prRef: ref,
        since: since({
          rebased: true,
          removedCommits: [commit("9", false, "Old attempt")],
          rebaseMatchSkipped: true,
        }),
        onOpenFile: () => {},
        onOpenCommit: () => {},
      }),
    );
    expect(textOf(html)).toContain("Gone since your review");
    expect(textOf(html)).toContain("Old attempt");
    expect(textOf(html)).toContain("every rewritten commit counts as new");
  });
});

describe("SinceReviewTab", () => {
  it("without a recorded review, explains how to get one and offers to mark it", async () => {
    primeCache(lastReviewKey(pr), {
      mark: null,
      shaExists: null,
      headSha: sha("b"),
      upToDate: false,
    });
    const marked: string[] = [];
    stubReviewApi({
      markReviewedHere: async (_ws, prId) => {
        marked.push(prId);
        return { ...since().mark, headSha: sha("b"), source: "manual" };
      },
    });
    const mounted = await mountForInteraction(createElement(SinceReviewTab, { ctx }));
    unmount = mounted.unmount;
    expect(mounted.host.textContent).toContain("No review of this pull request is recorded yet");
    [...mounted.host.querySelectorAll("button")]
      .find((b) => b.textContent === "Mark reviewed here")
      ?.click();
    await waitFor(() => marked.length > 0, "the mark");
    expect(marked).toEqual(["pr1"]);
  });

  it("says when nothing has changed since the review", async () => {
    primeCache(lastReviewKey(pr), {
      ...last,
      mark: { ...last.mark!, headSha: sha("b") },
      upToDate: true,
    });
    const html = await renderToHtml(createElement(SinceReviewTab, { ctx }));
    expect(textOf(html)).toContain("Nothing has changed since you reviewed bbbbbbb");
  });
});
