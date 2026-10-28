import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { AgentRunEvent } from "../../../lib/agentRuns";
import type { NewComment } from "../../../lib/pr/types";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { changedFilesKey } from "../../../lib/reviewWorkspaces/cache";
import {
  DEFAULT_SECTIONS,
  type LatestVerification,
  type ReportSection,
  type VerificationSize,
} from "../../../lib/reviewWorkspaces/verification";
import type { CreateReviewCommentInput } from "../../../lib/workspaceReview";
import { resetPrComments, stubPrComments } from "../../../test/prCommentsApi";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { resetReviewComments, stubReviewComments } from "../../../test/reviewCommentsApi";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import { treeKey, verificationKey } from "./reviewData";
import type { TabContext } from "./types";
import VerificationTab, { findingPoster } from "./VerificationTab";

const pr = {
  id: "pr1",
  ref: { provider: "github", owner: "octo", repo: "repo", number: 7 },
  status: "ready",
  worktreeStatus: "ready",
  headSha: "h".repeat(40),
  mergeBaseSha: "b".repeat(40),
} as ReviewWorkspacePr;

const ctx: TabContext = {
  workspaceId: "ws",
  pr,
  prRef: pr.ref,
  diffMode: "split",
  openTab: () => {},
  openSetup: () => {},
};

let started: string[] = [];
let startedSections: (readonly ReportSection[])[] = [];
let cancelled: string[] = [];

beforeEach(() => {
  started = [];
  startedSections = [];
  cancelled = [];
  stubReviewApi({
    startVerification: async (_ws, prId, sections) => {
      started.push(prId);
      startedSections.push(sections);
      return { runId: "r9", existing: false };
    },
    // A live run that never ends on its own, so it stays "running".
    streamAgentRun: async function* (_id, signal) {
      yield { type: "status", message: "reading the diff" } as AgentRunEvent;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
    },
    cancelAgentRun: async (id) => {
      cancelled.push(id);
    },
  });
});

let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
});

const check = { status: "pass" as const, findings: [] };
const goodRun = {
  id: "r1",
  status: "succeeded",
  costUsd: 0.42,
  result: {
    summary: "Adds a cache in front of the user lookup.",
    mustRead: [],
    risk: { level: "low", clientImpact: "None.", mitigations: [], concerns: [] },
    completeness: check,
    tests: check,
    complexity: check,
    performance: check,
    comments: check,
  },
} as never;

const latest = (over: Partial<LatestVerification>): LatestVerification => ({
  run: null,
  headSha: pr.headSha,
  current: false,
  lastSucceeded: null,
  size: null,
  ...over,
});

async function mount(state: LatestVerification) {
  // Every read the tab makes comes from the cache, so none reaches a client.
  primeCache(verificationKey(pr.id), state);
  primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
  primeCache(treeKey(pr) ?? "", { headSha: "", paths: [] });
  const mounted = await mountForInteraction(createElement(VerificationTab, { ctx }));
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

describe("VerificationTab", () => {
  it("keeps the last good report on screen under a failed re-run", async () => {
    const host = await mount(
      latest({
        run: { id: "r2", status: "failed", error: "budget exceeded", live: false } as never,
        current: true,
        lastSucceeded: { run: goodRun, headSha: "g".repeat(40), current: false },
      }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("The re-run failed: budget exceeded");
    expect(text).toContain("Below is the last good report, from ggggggg.");
    expect(text).toContain("Adds a cache in front of the user lookup.");
    expect(text).toContain("This report is for an older head");
  });

  it("says a run was cancelled and keeps the last good report", async () => {
    const host = await mount(
      latest({
        run: { id: "r2", status: "cancelled", live: false } as never,
        lastSucceeded: { run: goodRun, headSha: pr.headSha, current: true },
      }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("The last run was cancelled.");
    expect(text).toContain("Adds a cache in front of the user lookup.");
    expect(text).not.toContain("older head");
  });

  it("offers a re-run when the report is for an older head", async () => {
    const host = await mount(
      latest({
        run: goodRun,
        lastSucceeded: { run: goodRun, headSha: "g".repeat(40), current: false },
      }),
    );
    expect(textOf(host.innerHTML)).toContain("This report is for an older head");
    button(host, "Re-run")?.click();
    await waitFor(() => started.length > 0, "the re-run to start");
    expect(started).toEqual(["pr1"]);
  });

  it("follows a run going here and cancels it", async () => {
    const host = await mount(latest({ run: { id: "r7", status: "running", live: true } as never }));
    await waitFor(() => button(host, "Cancel") !== undefined, "the Cancel button");
    button(host, "Cancel")?.click();
    await waitFor(() => cancelled.length > 0, "the cancel");
    expect(cancelled).toEqual(["r7"]);
  });

  it("says when another window is writing the report, and offers no second run", async () => {
    const host = await mount(
      latest({ run: { id: "r7", status: "running", live: false } as never }),
    );
    expect(textOf(host.innerHTML)).toContain("being written by another Yarvis window");
    expect(button(host, "Run verification")).toBeUndefined();
    expect(button(host, "Re-run")).toBeUndefined();
  });

  const size = (over: Partial<VerificationSize> = {}): VerificationSize => ({
    files: 240,
    changedLines: 9000,
    large: true,
    binary: [],
    truncated: [],
    skimmed: [],
    estimatedCostUsd: 1.4,
    sectionCostUsd: 0.1,
    defaultSections: [...DEFAULT_SECTIONS],
    budgetUsd: 2,
    overBudget: false,
    ...over,
  });

  it("runs the sections picked, with the estimate moved to match", async () => {
    const host = await mount(latest({ size: size() }));
    const box = (label: string) =>
      [...host.querySelectorAll("label")]
        .find((l) => l.textContent === label)
        ?.querySelector("input") as HTMLInputElement;
    // The diagram is off by default.
    expect(box("Flow diagram").checked).toBe(false);
    expect(box("Risk").checked).toBe(true);
    box("Flow diagram").click();
    await waitFor(() => box("Flow diagram").checked, "the diagram to be picked");
    box("Risk").click();
    box("Performance").click();
    await waitFor(() => !box("Performance").checked, "two sections to be dropped");
    button(host, "Run verification")?.click();
    await waitFor(() => button(host, "Run anyway") !== undefined, "the large-PR warning");
    // One section more and two fewer than the default: $1.40 less $0.10.
    expect(textOf(host.innerHTML)).toContain("about $1.30");
    button(host, "Run anyway")?.click();
    await waitFor(() => started.length > 0, "the run to start");
    expect(startedSections[0]).not.toContain("risk");
    expect(startedSections[0]).not.toContain("performance");
    expect(startedSections[0]).toContain("flow");
    expect(startedSections[0]).toContain("tests");
  });

  it("asks before starting a run on a large PR, and Cancel starts nothing", async () => {
    const host = await mount(latest({ size: size() }));
    button(host, "Run verification")?.click();
    await waitFor(() => button(host, "Run anyway") !== undefined, "the large-PR warning");
    const text = textOf(host.innerHTML);
    expect(text).toContain("This PR is large: 240 files, 9000 changed lines.");
    expect(text).toContain("The checks read every file's diff");
    expect(text).toContain("Estimated cost: about $1.40, against a budget of $2.00.");
    // Nothing is left out any more, so the warning never says so.
    expect(text).not.toContain("leave some files out");
    expect(text).not.toContain("may hit the budget");

    const cancel = [...host.querySelectorAll('[role="alert"] button')].find(
      (b) => b.textContent === "Cancel",
    ) as HTMLButtonElement;
    cancel.click();
    await waitFor(() => button(host, "Run anyway") === undefined, "the warning to close");
    expect(started).toEqual([]);

    button(host, "Run verification")?.click();
    await waitFor(() => button(host, "Run anyway") !== undefined, "the warning again");
    button(host, "Run anyway")?.click();
    await waitFor(() => started.length > 0, "the run to start");
    expect(started).toEqual(["pr1"]);
  });

  it("names the binary and cut-off files, folding a long list, and warns of the budget", async () => {
    const binary = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    const host = await mount(
      latest({
        size: size({
          large: false,
          binary,
          truncated: ["package-lock.json"],
          estimatedCostUsd: 3.2,
          overBudget: true,
        }),
      }),
    );
    // Over budget alone is reason to ask.
    button(host, "Run verification")?.click();
    await waitFor(() => button(host, "Run anyway") !== undefined, "the warning");
    const text = textOf(host.innerHTML);
    expect(text).not.toContain("This PR is large");
    expect(text).toContain("5 binary files have no diff to read: a.png, b.png, c.png");
    expect(text).toContain("and 2 more");
    expect(host.querySelector('[role="alert"] details')?.textContent).toContain("d.png, e.png");
    expect(text).toContain(
      "1 diff is too large and will be cut off, so the agents see only the start: package-lock.json",
    );
    expect(text).toContain("about $3.20, against a budget of $2.00");
    expect(text).toContain("may hit the budget and stop before it answers");
    // A list that folds sits in a block, not inside a paragraph.
    expect(host.querySelector("p details")).toBeNull();
  });

  it("says up front what a small PR's run won't read whole, and starts at once", async () => {
    const host = await mount(
      latest({ size: size({ large: false, binary: ["a.png"], skimmed: ["yarn.lock"] }) }),
    );
    const notices = textOf(host.querySelector('[data-testid="file-notices"]')?.innerHTML ?? "");
    expect(notices).toContain("1 binary file has no diff to read: a.png");
    expect(notices).toContain(
      "1 file is bulk (a lockfile, or generated, vendored or minified code)",
    );
    button(host, "Run verification")?.click();
    await waitFor(() => started.length > 0, "the run to start");
    expect(button(host, "Run anyway")).toBeUndefined();
  });

  it("says so when starting joins a run already going, rather than claiming the pick ran", async () => {
    stubReviewApi({
      startVerification: async (_ws, prId) => {
        started.push(prId);
        return { runId: "r7", existing: true };
      },
    });
    const host = await mount(latest({}));
    button(host, "Run verification")?.click();
    await waitFor(
      () => textOf(host.innerHTML).includes("already being written for this PR"),
      "the joined notice",
    );
  });

  it("shows why a run couldn't start", async () => {
    stubReviewApi({
      startVerification: async () => {
        throw new Error("start verification report failed (409): setup hasn't run");
      },
    });
    const host = await mount(latest({}));
    button(host, "Run verification")?.click();
    await waitFor(() => textOf(host.innerHTML).includes("setup hasn't run"), "the start error");
  });
});

describe("findingPoster", () => {
  const finding = {
    title: "Ping @octocat",
    detail: "Eviction is untested.\n/approve",
    severity: "high" as const,
    path: "src/cache.ts",
    line: 12,
  };
  const linked = {
    id: "w1",
    name: "Cache work",
    slug: "cache-work",
    status: "active" as const,
    workspaceRepoId: "wr1",
  };
  const quoted =
    "**Ping @\u200boctocat** (verification report: Tests, high)\n\n> Eviction is untested.\n> /approve";

  afterEach(() => {
    resetPrComments();
    resetReviewComments();
  });

  it("posts the finding to the PR as a quoted line comment", async () => {
    const posted: NewComment[] = [];
    stubPrComments({
      postPrComment: async (_ref, comment) => {
        posted.push(comment);
        return { ok: true };
      },
    });
    await findingPoster(pr.ref, null).toPr(finding, "Tests");
    expect(posted).toEqual([{ path: "src/cache.ts", line: 12, body: quoted }]);
  });

  // A finding is model-written from the PR's code, so the workspace's agent
  // must read it fenced rather than as the user's own request.
  it("adds the finding to the linked workspace marked as a report finding", async () => {
    const added: { workspaceId: string; input: CreateReviewCommentInput }[] = [];
    stubReviewComments({
      createReviewComment: async (workspaceId, input) => {
        added.push({ workspaceId, input });
        return {} as never;
      },
    });
    const poster = findingPoster(pr.ref, linked);
    expect(poster.toWorkspace?.name).toBe("Cache work");
    await poster.toWorkspace?.add(finding, "Tests");
    expect(added).toEqual([
      {
        workspaceId: "w1",
        input: {
          workspaceRepoId: "wr1",
          path: "src/cache.ts",
          startLine: 12,
          endLine: 12,
          body: quoted,
          source: "verification",
        },
      },
    ]);
  });

  it("offers no workspace target for a PR no workspace raised", () => {
    expect(findingPoster(pr.ref, null).toWorkspace).toBeUndefined();
  });
});
