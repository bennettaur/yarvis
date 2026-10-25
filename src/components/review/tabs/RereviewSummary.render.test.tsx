import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { prDetailKey } from "../../../lib/pr/cache";
import type { PrRef, ReviewThread } from "../../../lib/pr/types";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { changedFilesKey } from "../../../lib/reviewWorkspaces/cache";
import type {
  LatestRereview,
  Rereview,
  RereviewComment,
} from "../../../lib/reviewWorkspaces/rereview";
import type { SinceReview } from "../../../lib/reviewWorkspaces/sinceReview";
import { mountForInteraction, renderToHtml, textOf, waitFor } from "../../../test/render";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import RereviewSummary, {
  groupComments,
  type RereviewLinks,
  RereviewView,
  reduceRereviewProgress,
} from "./RereviewSummary";
import { rereviewKey } from "./reviewData";
import type { TabContext, TabSpec } from "./types";

const ref: PrRef = { provider: "github", owner: "acme", repo: "widgets", number: 7 };
const sha = (c: string) => c.repeat(40);

const judged = (
  threadId: string,
  verdict: RereviewComment["verdict"],
  over: Partial<RereviewComment> = {},
): RereviewComment => ({
  threadId,
  kind: "thread",
  providerId: `node-${threadId}`,
  path: "src/cache.ts",
  line: 13,
  verdict,
  evidence: { note: `note for ${threadId}` },
  ...over,
});

const review: Rereview = {
  summary: "Removed the token log. Left the cache alone.",
  verdict: "needs_another_look",
  verdictReason: "Cache TTL not addressed; new retry logic.",
  comments: [
    judged("T1", "addressed", { path: "src/session.ts", evidence: { note: "Log removed." } }),
    judged("T2", "disagreed", {
      path: "src/rateLimit.ts",
      line: 1,
      replySummary: "A security control; stays constant.",
    }),
    judged("T3", "not_addressed"),
    judged("T4", "unclear", { downgradedFrom: "addressed" }),
    judged("T5", "partly"),
  ],
  newChanges: [
    {
      path: "src/retry.ts",
      lines: { start: 2, end: 10 },
      kind: "needs_review",
      reason: "<b>Backoff</b> and **5** attempts.",
    },
    { path: "src/format.ts", kind: "minor", reason: "Typo fixes." },
  ],
};

const thread = (id: string, body: string): ReviewThread => ({
  id,
  path: "src/cache.ts",
  line: 13,
  side: "RIGHT",
  isResolved: false,
  isOutdated: false,
  canReply: true,
  canResolve: true,
  canUnresolve: true,
  comments: [{ id: `${id}-c`, author: "mike", body, createdAt: "2026-10-01T00:00:00Z" }],
});

const opened: { what: string; path: string; line?: number }[] = [];
const links = (diffable: string[], since: string[]): RereviewLinks => ({
  canOpenDiff: (p) => diffable.includes(p),
  openDiff: (path, line) => opened.push({ what: "diff", path, line }),
  canOpenInterdiff: (p) => since.includes(p),
  openInterdiff: (path) => opened.push({ what: "interdiff", path }),
});

function view(over: Partial<Parameters<typeof RereviewView>[0]> = {}) {
  return createElement(RereviewView, {
    review,
    threads: new Map([["node-T3", thread("node-T3", "Entries never expire.")]]),
    conversation: new Map(),
    threadProps: (t) => ({ thread: t, onReply: async () => {}, onResolve: async () => {} }),
    links: links(["src/cache.ts"], ["src/retry.ts"]),
    ...over,
  });
}

let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
  opened.length = 0;
});

describe("grouping the comments", () => {
  it("puts the open ones first, worst first, then disagreements, then the addressed", () => {
    const groups = groupComments(review.comments);
    expect(groups.open.map((c) => c.threadId)).toEqual(["T3", "T5", "T4"]);
    expect(groups.disagreed.map((c) => c.threadId)).toEqual(["T2"]);
    expect(groups.addressed.map((c) => c.threadId)).toEqual(["T1"]);
  });
});

describe("RereviewView", () => {
  it("leads with the verdict, then the comments by group and the other changes", async () => {
    const text = textOf(await renderToHtml(view()));
    const order = [
      "Needs another look",
      "Cache TTL not addressed",
      "Removed the token log",
      "Still open (3)",
      "Answered with a reason (1)",
      "Addressed (1)",
      "Needs your review (1)",
      "Minor (1)",
    ].map((s) => text.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Their reason: A security control; stays constant.");
    expect(text).toContain('The agent said "addressed" but cited no changed code');
  });

  it("collapses the addressed comments and the minor changes", async () => {
    const html = await renderToHtml(view());
    const details = html.match(/<details>[\s\S]*?<\/details>/g) ?? [];
    expect(details).toHaveLength(2);
    expect(details[0]).toContain("Log removed.");
    expect(details[1]).toContain("Typo fixes.");
    expect(html).not.toMatch(/<details open/);
  });

  it("shows agent text as plain text", async () => {
    const html = await renderToHtml(view());
    expect(html).not.toContain("<b>Backoff</b>");
    expect(html).toContain("&lt;b&gt;Backoff&lt;/b&gt; and **5** attempts.");
  });

  it("shows the thread with its controls, and links only paths the PR has", async () => {
    const mounted = await mountForInteraction(view());
    unmount = mounted.unmount;
    const host = mounted.host;
    expect(host.textContent).toContain("Entries never expire.");
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent === "Reply")).toBe(true);
    expect(buttons.some((b) => b.textContent?.includes("Resolve"))).toBe(true);

    // src/rateLimit.ts isn't among the changed files: text, not a link.
    expect(buttons.some((b) => b.textContent === "src/rateLimit.ts:1")).toBe(false);
    expect(host.textContent).toContain("src/rateLimit.ts:1");
    buttons.find((b) => b.textContent === "src/cache.ts:13")?.click();
    buttons.find((b) => b.textContent === "src/retry.ts")?.click();
    expect(buttons.some((b) => b.textContent === "src/format.ts")).toBe(false);
    expect(opened).toEqual([
      { what: "diff", path: "src/cache.ts", line: 13 },
      { what: "interdiff", path: "src/retry.ts" },
    ]);
  });

  it("says when every comment is settled and nothing needs review", async () => {
    const text = textOf(
      await renderToHtml(
        view({
          review: {
            ...review,
            verdict: "ready_to_approve",
            verdictReason: "All addressed.",
            comments: [review.comments[0] as RereviewComment],
            newChanges: [],
          },
        }),
      ),
    );
    expect(text).toContain("Ready to approve");
    expect(text).toContain("Nothing changed beyond the fixes for your comments.");
  });
});

describe("following a run", () => {
  it("counts its steps and keeps its latest activity", () => {
    let p = { activity: null, steps: 0, finished: null, error: null } as Parameters<
      typeof reduceRereviewProgress
    >[0];
    p = reduceRereviewProgress(p, { type: "status", message: "Starting Claude Code" });
    p = reduceRereviewProgress(p, {
      type: "tool",
      id: "1",
      name: "Read",
      summary: "src/a.ts",
      subagentId: null,
    });
    p = reduceRereviewProgress(p, { type: "done", status: "succeeded" });
    expect(p).toEqual({ activity: "Read src/a.ts", steps: 1, finished: "succeeded", error: null });
  });
});

// ---------------------------------------------------------------------------

const pr = {
  id: "pr1",
  ref,
  status: "ready",
  worktreeStatus: "ready",
  headSha: sha("b"),
  baseSha: sha("e"),
  mergeBaseSha: sha("e"),
} as ReviewWorkspacePr;
const tabs: TabSpec[] = [];
const ctx: TabContext = {
  workspaceId: "ws",
  pr,
  prRef: ref,
  diffMode: "split",
  openTab: (spec) => tabs.push(spec),
  openSetup: () => {},
};
const since = {
  fromHeadSha: sha("a"),
  toHeadSha: sha("b"),
  files: [{ path: "src/retry.ts" }],
} as SinceReview;

const nothingYet: LatestRereview = {
  run: null,
  fromHeadSha: sha("a"),
  headSha: sha("b"),
  current: false,
  lastSucceeded: null,
};

function primeReads(latest: LatestRereview) {
  primeCache(rereviewKey(pr.id, sha("a")), latest);
  primeCache(prDetailKey(ref), { reviewThreads: [], conversation: [] });
  primeCache(changedFilesKey(pr) as string, {
    headSha: sha("b"),
    mergeBaseSha: sha("e"),
    files: [{ path: "src/cache.ts" }],
  });
}

describe("RereviewSummary", () => {
  it("starts by itself when the setting is on and the range has no summary", async () => {
    primeReads(nothingYet);
    const started: (string | undefined)[] = [];
    stubReviewApi({
      getRereviewRunConfig: async () => ({ model: "sonnet", maxBudgetUsd: 1, autoStart: true }),
      startRereview: async (_ws, _pr, from) => {
        started.push(from);
        return { runId: "run1", existing: false, fromHeadSha: sha("a"), toHeadSha: sha("b") };
      },
      latestRereview: async () => nothingYet,
      streamAgentRun: async function* () {},
    });
    const mounted = await mountForInteraction(createElement(RereviewSummary, { ctx, since }));
    unmount = mounted.unmount;
    await waitFor(() => started.length > 0, "the auto-start");
    expect(started).toEqual([sha("a")]);
  });

  it("waits for the button when the setting is off", async () => {
    primeReads(nothingYet);
    const started: (string | undefined)[] = [];
    stubReviewApi({
      getRereviewRunConfig: async () => ({ model: "sonnet", maxBudgetUsd: 1, autoStart: false }),
      startRereview: async (_ws, _pr, from) => {
        started.push(from);
        return { runId: "run1", existing: false, fromHeadSha: sha("a"), toHeadSha: sha("b") };
      },
      latestRereview: async () => nothingYet,
      streamAgentRun: async function* () {},
    });
    const mounted = await mountForInteraction(createElement(RereviewSummary, { ctx, since }));
    unmount = mounted.unmount;
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([]);
    [...mounted.host.querySelectorAll("button")]
      .find((b) => b.textContent === "What's changed")
      ?.click();
    await waitFor(() => started.length > 0, "the start");
    expect(started).toEqual([sha("a")]);
  });

  it("shows the last good summary, saying when it covers another range", async () => {
    const run = {
      id: "run0",
      status: "succeeded" as const,
      result: review,
      error: null,
      costUsd: 0.04,
      startedAt: "2026-10-01T00:00:00Z",
      finishedAt: "2026-10-01T00:01:00Z",
      fromHeadSha: sha("9"),
      toHeadSha: sha("b"),
    };
    primeReads({
      ...nothingYet,
      run: { ...run, live: false },
      lastSucceeded: { run, fromHeadSha: sha("9"), toHeadSha: sha("b"), current: false },
    });
    stubReviewApi({
      getRereviewRunConfig: async () => ({ model: "sonnet", maxBudgetUsd: 1, autoStart: false }),
    });
    const text = textOf(await renderToHtml(createElement(RereviewSummary, { ctx, since })));
    expect(text).toContain("Needs another look");
    expect(text).toContain("not what this tab compares now");
    expect(text).toContain("Re-run");
  });
});
