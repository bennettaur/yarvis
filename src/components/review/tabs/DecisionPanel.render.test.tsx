import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { NewComment, PrRef } from "../../../lib/pr/types";
import {
  type ChecklistItem,
  DEFAULT_SECTIONS,
  type EvidenceItem,
  type VerificationReport,
} from "../../../lib/reviewWorkspaces/verification";
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

const green: EvidenceItem[] = [
  {
    id: "ci-checks",
    theme: "correctness",
    label: "CI checks",
    description: "",
    summary: "All 3 passed",
    tone: "good",
    entries: [],
    hiddenEntries: 0,
    note: null,
  },
];

/** Every default section with a result for this commit. */
const ranAll: ChecklistItem[] = DEFAULT_SECTIONS.map((section) => ({
  section,
  theme: "correctness",
  label: section,
  description: "",
  latest: null,
  result: {
    id: "r",
    status: "succeeded",
    live: false,
    headSha: seen.headSha,
    current: true,
    error: null,
    costUsd: null,
    startedAt: "",
    finishedAt: null,
  },
}));

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

function stubReview({
  failComment,
  failVerdict,
}: {
  failComment?: string;
  failVerdict?: boolean;
} = {}) {
  stubPrApi({
    applyReviewAction: async (_ref, action, body) => {
      if (failVerdict) throw new Error("GitHub said no");
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
      evidence: green,
      items: over.items ?? ranAll,
      currentSections: new Set(["claims", "changeMap"]),
      onOpen: { open: (path, line) => opened.push([path, line]), canOpen: () => true },
    }),
  );
  unmount = mounted.unmount;
  return { host: mounted.host, opened };
}

const button = (host: Element, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

/** Types into a field through the prototype's setter, which React's change tracking needs. */
function typeInto(field: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

const field = (host: Element, label: string) =>
  host.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement;

async function openRequestChanges(host: HTMLElement) {
  button(host, "Request changes").click();
  await waitFor(() => !!button(host, "Request changes (2)"), "the drafted comments");
}

describe("DecisionPanel", () => {
  it("leads with the suggestion, the PR's intent and every reason", async () => {
    const { host } = await mount();
    const text = textOf(host.innerHTML);
    expect(text).toContain("Changes needed");
    expect(text).toContain("Cache user lookups.");
    expect(text).toContain("Claim missing: Invalidates on write");
    expect(text).toContain("1 change doesn't seem to belong to the PR's goal: Bump timeout");
  });

  it("posts the ticked comments on their lines, then requests changes with the summary", async () => {
    stubReview();
    const { host } = await mount();
    await openRequestChanges(host);
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
        body: "Requesting changes based on the verification report.\n\n2 more comments are on the diff.",
      },
    ]);
    await waitFor(() => textOf(host.innerHTML).includes("Changes requested."), "the status");
  });

  it("posts the reviewer's own words, for a comment and for the summary", async () => {
    stubReview();
    const { host } = await mount();
    await openRequestChanges(host);
    typeInto(field(host, "Comment on Bump timeout"), "Please split this out.");
    typeInto(field(host, "Review summary"), "Two things to fix.");
    button(host, "Request changes (2)").click();
    await waitFor(() => reviews.length > 0, "the verdict");
    expect(comments.find((c) => c.path === "src/http.ts")?.body).toBe("Please split this out.");
    expect(reviews[0]?.body).toBe("Two things to fix.");
  });

  it("won't send an empty summary", async () => {
    const { host } = await mount();
    await openRequestChanges(host);
    typeInto(field(host, "Review summary"), "  ");
    await waitFor(() => button(host, "Request changes (2)").disabled, "the disabled button");
  });

  it("sends no verdict when a comment fails, and doesn't repeat the posted ones on a retry", async () => {
    stubReview({ failComment: "src/http.ts" });
    const { host } = await mount();
    await openRequestChanges(host);
    button(host, "Request changes (2)").click();
    await waitFor(() => textOf(host.innerHTML).includes("line outside the diff"), "the error");
    expect(reviews).toEqual([]);
    expect(comments.map((c) => c.path)).toEqual(["src/users.ts"]);
    const posted = host.querySelector(
      'input[aria-label="Include Invalidates on write"]',
    ) as HTMLInputElement;
    expect(posted.disabled).toBe(true);
    expect(textOf(host.innerHTML)).toContain("posted");

    stubReview();
    button(host, "Request changes (2)").click();
    await waitFor(() => reviews.length > 0, "the verdict");
    expect(comments.map((c) => c.path)).toEqual(["src/users.ts", "src/http.ts"]);
  });

  it("when only the verdict fails, a retry sends just the verdict", async () => {
    stubReview({ failVerdict: true });
    const { host } = await mount();
    await openRequestChanges(host);
    button(host, "Request changes (2)").click();
    await waitFor(() => textOf(host.innerHTML).includes("GitHub said no"), "the error");
    expect(comments).toHaveLength(2);

    stubReview();
    button(host, "Request changes (2)").click();
    await waitFor(() => reviews.length > 0, "the verdict");
    expect(comments).toHaveLength(2);
  });

  it("leaves out an unticked comment", async () => {
    stubReview();
    const { host } = await mount();
    await openRequestChanges(host);
    (host.querySelector('input[aria-label="Include Bump timeout"]') as HTMLInputElement).click();
    await waitFor(() => !!button(host, "Request changes (1)"), "one ticked");
    button(host, "Request changes (1)").click();
    await waitFor(() => reviews.length > 0, "the verdict");
    expect(comments.map((c) => c.path)).toEqual(["src/users.ts"]);
  });

  it("approves with the reviewer's note, trimmed, after saying what argues against it", async () => {
    stubReview();
    const { host } = await mount();
    button(host, "Approve").click();
    await waitFor(() => !!button(host, "Submit approval"), "the approval form");
    expect(textOf(host.innerHTML)).toContain("The report raised 2 things above.");
    typeInto(field(host, "Approval comment"), "  Fine by me.  ");
    button(host, "Submit approval").click();
    await waitFor(() => reviews.length > 0, "the approval");
    expect(reviews).toEqual([{ action: "approve", body: "Fine by me." }]);
  });

  it("warns before approving when checks haven't run, and shows a failed approval", async () => {
    stubReview({ failVerdict: true });
    const { host } = await mount({
      report: { mustRead: [] },
      items: ranAll.map((i) => ({ ...i, result: null })),
    });
    expect(textOf(host.innerHTML)).toContain("Run the checks first");
    button(host, "Approve").click();
    await waitFor(() => !!button(host, "Submit approval"), "the approval form");
    // Improvements are follow-ups, so a run not had isn't one to wait on.
    const awaited = ranAll.filter((i) => i.section !== "improvements").length;
    expect(textOf(host.innerHTML)).toContain(`${awaited} checks haven't run on this commit.`);
    button(host, "Submit approval").click();
    await waitFor(() => !!host.querySelector('[role="alert"]'), "the error");
    expect(textOf(host.innerHTML)).toContain("GitHub said no");
    expect(textOf(host.innerHTML)).not.toContain("Approved.");
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
