import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { NewComment, PrRef } from "../../../lib/pr/types";
import type { ChecklistItem, VerificationReport } from "../../../lib/reviewWorkspaces/verification";
import { resetPrApi, stubPrApi } from "../../../test/prApi";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import DecisionPanel from "./DecisionPanel";

const prRef: PrRef = { provider: "github", owner: "o", repo: "r", number: 7 };
const seen = { headSha: "h".repeat(40), mergeBaseSha: "b".repeat(40) };

const report: VerificationReport = {
  summary: "Adds a cache.",
  mustRead: [{ path: "src/cache.ts", reason: "the eviction logic" }],
  changeMap: {
    intent: "Cache user lookups.",
    unmapped: [],
    themes: [
      {
        title: "Bump timeout",
        description: "",
        risk: "low",
        cohesion: "outlier",
        question: "Why the timeout?",
        files: [{ path: "src/http.ts", lines: { start: 4, end: 4 } }],
      },
    ],
  },
  claims: {
    items: [
      {
        claim: "Invalidates on write",
        source: "ABC-1",
        status: "missing",
        evidence: "No write path clears it",
        path: "src/users.ts",
        line: 30,
      },
    ],
    gaps: [],
  },
};

let reviews: { action: string; body?: string }[] = [];
let comments: NewComment[] = [];
let unmount = () => {};

afterEach(() => {
  unmount();
  reviews = [];
  comments = [];
  resetPrApi();
});
afterAll(resetPrApi);

function stubReview(failComment?: string) {
  stubPrApi({
    applyReviewAction: async (_ref, action, body) => {
      reviews.push({ action, body });
    },
    postPrComment: async (_ref, comment) => {
      if (comment.path === failComment) throw new Error("line outside the diff");
      comments.push(comment);
      return { ok: true };
    },
  });
}

async function mount(over: { report?: VerificationReport; items?: ChecklistItem[] } = {}) {
  const opened: unknown[] = [];
  const mounted = await mountForInteraction(
    createElement(DecisionPanel, {
      prRef,
      seen,
      report: over.report ?? report,
      evidence: [],
      items: over.items ?? [],
      currentSections: new Set(["claims", "changeMap"]),
      onOpen: { open: (path, line) => opened.push([path, line]), canOpen: () => true },
    }),
  );
  unmount = mounted.unmount;
  return { host: mounted.host, opened };
}

const button = (host: Element, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

describe("DecisionPanel", () => {
  it("leads with the suggestion, the PR's intent and every reason", async () => {
    const { host } = await mount();
    const text = textOf(host.innerHTML);
    expect(text).toContain("Changes needed");
    expect(text).toContain("Cache user lookups.");
    expect(text).toContain("Claim missing: Invalidates on write");
    expect(text).toContain("1 change doesn't belong to the PR's goal: Bump timeout");
  });

  it("posts the ticked comments on their lines, then requests changes with the summary", async () => {
    stubReview();
    const { host } = await mount();
    button(host, "Request changes").click();
    await waitFor(() => !!button(host, "Request changes (2)"), "the drafted comments");
    button(host, "Request changes (2)").click();
    await waitFor(() => reviews.length > 0, "the verdict");
    expect(comments.map((c) => [c.path, c.line])).toEqual([
      ["src/users.ts", 30],
      ["src/http.ts", 4],
    ]);
    expect(comments[1]?.body).toContain("> Why the timeout?");
    expect(reviews).toEqual([
      {
        action: "request_changes",
        body: "Requesting changes, from the verification report.\n\n2 comments are on the lines they're about.",
      },
    ]);
    await waitFor(() => textOf(host.innerHTML).includes("Changes requested."), "the status");
  });

  it("sends no verdict when a comment fails, and doesn't repeat the posted ones on a retry", async () => {
    stubReview("src/http.ts");
    const { host } = await mount();
    button(host, "Request changes").click();
    await waitFor(() => !!button(host, "Request changes (2)"), "the drafted comments");
    button(host, "Request changes (2)").click();
    await waitFor(() => textOf(host.innerHTML).includes("line outside the diff"), "the error");
    expect(reviews).toEqual([]);
    expect(comments.map((c) => c.path)).toEqual(["src/users.ts"]);

    stubReview();
    button(host, "Request changes (2)").click();
    await waitFor(() => reviews.length > 0, "the verdict");
    expect(comments.map((c) => c.path)).toEqual(["src/users.ts", "src/http.ts"]);
  });

  it("leaves out an unticked comment", async () => {
    stubReview();
    const { host } = await mount();
    button(host, "Request changes").click();
    await waitFor(() => !!button(host, "Request changes (2)"), "the drafted comments");
    (host.querySelector('input[aria-label="Include Bump timeout"]') as HTMLInputElement).click();
    await waitFor(() => !!button(host, "Request changes (1)"), "one ticked");
    button(host, "Request changes (1)").click();
    await waitFor(() => reviews.length > 0, "the verdict");
    expect(comments.map((c) => c.path)).toEqual(["src/users.ts"]);
  });

  it("approves with the reviewer's note, after saying what argues against it", async () => {
    stubReview();
    const { host } = await mount();
    button(host, "Approve").click();
    await waitFor(() => !!button(host, "Submit approval"), "the approval form");
    expect(textOf(host.innerHTML)).toContain("The report raised 2 things above.");
    button(host, "Submit approval").click();
    await waitFor(() => reviews.length > 0, "the approval");
    expect(reviews).toEqual([{ action: "approve", body: undefined }]);
  });

  it("lists where to look deeper, each opening the diff", async () => {
    const { host, opened } = await mount();
    button(host, "Review deeper").click();
    await waitFor(() => !!button(host, "src/http.ts:4"), "the places");
    expect(textOf(host.innerHTML)).toContain("Outlier: Bump timeout");
    expect(textOf(host.innerHTML)).toContain("the eviction logic");
    button(host, "src/http.ts:4").click();
    expect(opened).toEqual([["src/http.ts", 4]]);
  });
});
