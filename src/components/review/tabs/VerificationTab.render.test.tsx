import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { type RunChoice, VERIFICATION_SETTINGS_KEY } from "../../../lib/pr/models";
import type { NewComment, SeenCommits } from "../../../lib/pr/types";
import { invalidate, primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { changedFilesKey } from "../../../lib/reviewWorkspaces/cache";
import type { MutationRun, MutationTestingState } from "../../../lib/reviewWorkspaces/mutation";
import {
  type ChecklistItem,
  type ChecklistRun,
  type ChecklistThemeId,
  DEFAULT_SECTIONS,
  type EvidenceItem,
  REPORT_SECTIONS,
  type ReportSection,
  type VerificationChecklist,
  type VerificationEvidence,
  type VerificationReport,
  type VerificationSize,
} from "../../../lib/reviewWorkspaces/verification";
import type { CreateReviewCommentInput } from "../../../lib/workspaceReview";
import { clipboardWrites, resetClipboardWrites } from "../../../test/clipboard";
import { resetPrApi, stubPrApi } from "../../../test/prApi";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { resetReviewComments, stubReviewComments } from "../../../test/reviewCommentsApi";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import { evidenceKey, mutationKey, treeKey, verificationKey } from "./reviewData";
import type { TabContext, TabSpec } from "./types";
import VerificationTab, { findingPoster, resultVerdict } from "./VerificationTab";

const pr = {
  id: "pr1",
  ref: { provider: "github", owner: "octo", repo: "repo", number: 7 },
  title: "Cache user lookups",
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
// What the checklist reads as after the cache is invalidated.
let reread: VerificationChecklist;
let mutationState: MutationTestingState;

beforeEach(() => {
  resetClipboardWrites();
  started = [];
  startedSections = [];
  cancelled = [];
  reread = checklist();
  mutationState = { run: null, headSha: HEAD, blocked: null, sandboxNotes: "" };
  stubReviewApi({
    getMutationTesting: async () => mutationState,
    verificationUpstack: async () => ({ headSha: HEAD, layers: [], note: null }),
    startVerification: async (_ws, prId, sections) => {
      started.push(prId);
      startedSections.push(sections);
      return {
        runs: sections.map((section) => ({ section, runId: `r9-${section}`, existing: false })),
        failed: [],
      };
    },
    // The checklist read again after a start or a cancel.
    verificationChecklist: async () => reread,
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
const goodReport: VerificationReport = {
  summary: "Adds a cache in front of the user lookup.",
  mustRead: [],
  risk: { level: "low", clientImpact: "None.", mitigations: [], concerns: [] },
  quality: check,
  tests: check,
};

const THEMES: VerificationChecklist["themes"] = [
  { id: "understand", label: "Understand the change" },
  { id: "correctness", label: "Correctness and tests" },
  { id: "risk", label: "Risk and impact" },
  { id: "maintainability", label: "Maintainability" },
];

const ENTRY: Record<ReportSection, { theme: ChecklistThemeId; label: string }> = {
  summary: { theme: "understand", label: "Summary and must-read files" },
  flow: { theme: "understand", label: "Flow diagram" },
  changeMap: { theme: "understand", label: "Change map" },
  claims: { theme: "correctness", label: "Claims" },
  tests: { theme: "correctness", label: "Test quality" },
  performance: { theme: "correctness", label: "Performance" },
  observability: { theme: "correctness", label: "Observability" },
  risk: { theme: "risk", label: "Risk" },
  malice: { theme: "risk", label: "Malicious intent" },
  complexity: { theme: "maintainability", label: "Complexity" },
  quality: { theme: "maintainability", label: "Code quality" },
  comments: { theme: "maintainability", label: "Comment quality" },
  approach: { theme: "maintainability", label: "Simpler approach" },
};

const run = (over: Partial<ChecklistRun> = {}): ChecklistRun => ({
  id: "r1",
  status: "succeeded",
  live: false,
  headSha: pr.headSha,
  current: true,
  error: null,
  costUsd: null,
  startedAt: "2026-11-15T00:00:00Z",
  finishedAt: null,
  ...over,
});

const older = "g".repeat(40);

/** A checklist with every section, none run unless `items` says otherwise. */
const checklist = ({
  items = {},
  report = null,
  size = null,
}: {
  items?: Partial<Record<ReportSection, Partial<ChecklistItem>>>;
  report?: VerificationReport | null;
  size?: VerificationSize | null;
} = {}): VerificationChecklist => ({
  headSha: pr.headSha,
  themes: THEMES,
  items: REPORT_SECTIONS.map((section) => ({
    section,
    ...ENTRY[section],
    description: `What ${section} checks.`,
    latest: null,
    result: null,
    ...items[section],
  })),
  report,
  size,
  namedTickets: [],
});

/** Every section in `report` answered by one current run. */
const answered = (report: VerificationReport) =>
  Object.fromEntries(
    REPORT_SECTIONS.filter((s) => s in report).map((s) => [s, { latest: run(), result: run() }]),
  );

const HEAD = pr.headSha as string;
const NO_EVIDENCE: VerificationEvidence = { headSha: HEAD, items: [] };

async function mount(state: VerificationChecklist, evidence: VerificationEvidence = NO_EVIDENCE) {
  // Every read the tab makes comes from the cache, so none reaches a client.
  primeCache(verificationKey(pr.id), state);
  primeCache(evidenceKey(pr.id), evidence);
  primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
  primeCache(treeKey(pr) ?? "", { headSha: "", paths: [] });
  const mounted = await mountForInteraction(createElement(VerificationTab, { ctx }));
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: Element, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

/** The checklist row for a section, by its label. */
const row = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("li")].find((li) =>
    [...li.querySelectorAll("span")].some((s) => s.textContent === label),
  ) as HTMLElement;

/**
 * Types into a text field through the prototype's value setter, since React's
 * value tracker swallows the change event when the property is assigned directly.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const pick = (host: HTMLElement, label: string) =>
  host.querySelector(`input[aria-label="Pick ${label}"]`) as HTMLInputElement;

describe("VerificationTab", () => {
  it("groups the checks by theme and says what each one's result found", async () => {
    const report: VerificationReport = {
      ...goodReport,
      tests: {
        status: "issues",
        findings: [
          { title: "No test for eviction", detail: "d", severity: "high" },
          { title: "Mocks the cache", detail: "d", severity: "low" },
        ],
      },
    };
    const host = await mount(checklist({ items: answered(report), report }));
    const text = textOf(host.innerHTML);
    for (const theme of THEMES) expect(text).toContain(theme.label);
    expect(textOf(row(host, "Test quality").innerHTML)).toContain("2 findings");
    expect(textOf(row(host, "Code quality").innerHTML)).toContain("Pass");
    expect(textOf(row(host, "Flow diagram").innerHTML)).toContain("Not run");
    expect(button(row(host, "Flow diagram"), "Run")).toBeDefined();
    expect(button(row(host, "Test quality"), "Re-run")).toBeDefined();
    expect(text).toContain("Adds a cache in front of the user lookup.");
    expect(text).toContain("No test for eviction");
  });

  it("copies the whole report as Markdown", async () => {
    const report: VerificationReport = {
      ...goodReport,
      tests: {
        status: "issues",
        findings: [{ title: "No test for eviction", detail: "d", severity: "high" }],
      },
    };
    const host = await mount(checklist({ items: answered(report), report }));
    const copy = host.querySelector(
      'button[aria-label="Copy the whole report as Markdown, to paste into Claude"]',
    ) as HTMLButtonElement;
    copy.click();
    await waitFor(() => clipboardWrites().length === 1);
    const [md] = clipboardWrites();
    expect(md).toContain("# Verification report: Cache user lookups");
    expect(md).toContain("PR: https://github.com/octo/repo/pull/7");
    expect(md).toContain("Suggested: **Changes needed**");
    expect(md).toContain("**[high] No test for eviction**");
  });

  it("keeps a section's last result under a failed re-run, marked as from an older head", async () => {
    const host = await mount(
      checklist({
        items: {
          tests: {
            latest: run({ id: "r2", status: "failed", error: "budget exceeded" }),
            result: run({ headSha: older, current: false }),
          },
        },
        report: { mustRead: [], tests: check },
      }),
    );
    const testRow = textOf(row(host, "Test quality").innerHTML);
    expect(testRow).toContain("Last run failed");
    expect(testRow).toContain("Pass");
    expect(testRow).toContain("older head (ggggggg)");
    expect(textOf(host.innerHTML)).toContain("Test quality · older head");
  });

  // Its line numbers are for the head it read, which may be different code now.
  it("offers posting a finding only from a section whose result is on the current head", async () => {
    const report: VerificationReport = {
      ...goodReport,
      risk: {
        level: "medium",
        clientImpact: "None.",
        mitigations: [],
        concerns: [
          { title: "Stale reads", detail: "Edits stay stale.", path: "src/cache.ts", line: 3 },
        ],
      },
    };
    const current = await mount(checklist({ items: answered(report), report }));
    expect(button(current, "Post to PR")).toBeDefined();
    unmount();

    const stale = await mount(
      checklist({
        items: {
          ...answered(report),
          risk: { latest: run(), result: run({ headSha: older, current: false }) },
        },
        report,
      }),
    );
    expect(textOf(stale.innerHTML)).toContain("Stale reads");
    expect(button(stale, "Post to PR")).toBeUndefined();
    unmount();

    // Per check: an older head's test findings can't post while a current check's can.
    const located = (title: string) => ({
      status: "issues" as const,
      findings: [{ title, detail: "d", severity: "medium" as const, path: "src/a.ts", line: 4 }],
    });
    const mixed: VerificationReport = {
      mustRead: [],
      tests: located("No eviction test"),
      performance: located("Misses the delete path"),
    };
    const checks = await mount(
      checklist({
        items: {
          ...answered(mixed),
          tests: { latest: run(), result: run({ headSha: older, current: false }) },
        },
        report: mixed,
      }),
    );
    expect(textOf(checks.innerHTML)).toContain("Test quality · older head");
    const posts = [...checks.querySelectorAll("button")].filter(
      (b) => b.textContent === "Post to PR",
    );
    // The one left is the current check's finding, not the older head's.
    expect(posts).toHaveLength(1);
    expect(posts[0]?.closest("li")?.textContent).toContain("Misses the delete path");
  });

  it("cancels a run going here", async () => {
    const host = await mount(
      checklist({ items: { tests: { latest: run({ id: "r7", status: "running", live: true }) } } }),
    );
    expect(textOf(row(host, "Test quality").innerHTML)).toContain("Running");
    button(row(host, "Test quality"), "Cancel")?.click();
    await waitFor(() => cancelled.length > 0, "the cancel");
    expect(cancelled).toEqual(["r7"]);
  });

  it("says when another instance is running a check, and offers no second run of it", async () => {
    const host = await mount(
      checklist({
        items: { tests: { latest: run({ id: "r7", status: "running", live: false }) } },
      }),
    );
    const testRow = row(host, "Test quality");
    expect(textOf(testRow.innerHTML)).toContain("Running in another Yarvis instance");
    expect(testRow.querySelector("button")).toBeNull();
    expect(pick(host, "Test quality").disabled).toBe(true);
  });

  it("picks the default checks with nothing for the current head, and runs what is picked", async () => {
    const host = await mount(
      checklist({
        items: {
          summary: { latest: run(), result: run() },
          risk: { latest: run(), result: run({ headSha: older, current: false }) },
        },
        report: { summary: "s", mustRead: [] },
      }),
    );
    // The summary has a current result and the diagram is off unless asked for.
    expect(pick(host, "Summary and must-read files").checked).toBe(false);
    expect(pick(host, "Flow diagram").checked).toBe(false);
    // A result for an older head is worth running again.
    expect(pick(host, "Risk").checked).toBe(true);
    const defaults = DEFAULT_SECTIONS.length - 1;
    expect(button(host, `Run picked (${defaults})`)).toBeDefined();

    pick(host, "Flow diagram").click();
    pick(host, "Performance").click();
    await waitFor(() => !pick(host, "Performance").checked, "the picks to change");
    button(host, `Run picked (${defaults})`)?.click();
    await waitFor(() => started.length > 0, "the runs to start");
    expect(startedSections[0]).toContain("flow");
    expect(startedSections[0]).toContain("risk");
    expect(startedSections[0]).not.toContain("performance");
    expect(startedSections[0]).not.toContain("summary");
  });

  it("runs one check from its row and shows it running once the checklist is read again", async () => {
    reread = checklist({
      items: {
        performance: { latest: run({ id: "r9-performance", status: "running", live: true }) },
      },
    });
    const host = await mount(checklist());
    button(row(host, "Performance"), "Run")?.click();
    await waitFor(() => started.length > 0, "the run to start");
    expect(startedSections).toEqual([["performance"]]);
    await waitFor(() => button(row(host, "Performance"), "Cancel") !== undefined, "Cancel");
    button(row(host, "Performance"), "Cancel")?.click();
    await waitFor(() => cancelled.length > 0, "the cancel");
    expect(cancelled).toEqual(["r9-performance"]);
  });

  it("sends the tickets the reviewer named with the checks it starts", async () => {
    let named: readonly string[] = [];
    stubReviewApi({
      startVerification: async (_ws, _pr, sections, tickets = []) => {
        named = tickets;
        return {
          runs: sections.map((section) => ({ section, runId: "r", existing: false })),
          failed: [],
        };
      },
    });
    const host = await mount(checklist());
    const input = host.querySelector(
      'input[placeholder="ABC-123, #45 or a ticket link"]',
    ) as HTMLInputElement;
    typeInto(input, "ABC-12, #45  https://acme.atlassian.net/browse/XY-3");
    button(row(host, "Claims"), "Run")?.click();
    await waitFor(() => named.length > 0, "the start");
    expect(named).toEqual(["ABC-12", "#45", "https://acme.atlassian.net/browse/XY-3"]);
  });

  it("starts checks on the model and effort picked for the run, or each check's own", async () => {
    const sent: RunChoice[] = [];
    stubReviewApi({
      startVerification: async (_ws, _pr, sections, _tickets, override = {}) => {
        sent.push(override);
        return {
          runs: sections.map((section) => ({ section, runId: "r", existing: false })),
          failed: [],
        };
      },
    });
    const host = await mount(checklist());
    button(row(host, "Risk"), "Run")?.click();
    await waitFor(() => sent.length === 1, "the first start");
    const choose = (label: string, value: string) => {
      const select = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        select,
        value,
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    choose("Model for the checks you run", "haiku");
    choose("Effort for the checks you run", "low");
    await waitFor(
      () =>
        (
          host.querySelector(
            'select[aria-label="Effort for the checks you run"]',
          ) as HTMLSelectElement
        ).value === "low",
      "the picks to change",
    );
    button(row(host, "Risk"), "Run")?.click();
    await waitFor(() => sent.length === 2, "the second start");
    expect(sent).toEqual([{}, { model: "haiku", effort: "low" }]);
  });

  it("starts checks with the harness picked for the run, or the one set in Settings", async () => {
    primeCache(VERIFICATION_SETTINGS_KEY, {
      maxBudgetUsd: 2,
      sections: {},
      sectionDefaults: [],
      harness: "bedrock",
      harnesses: [
        { id: "claude", name: "Claude" },
        { id: "bedrock", name: "Bedrock" },
      ],
    });
    const sent: (string | undefined)[] = [];
    stubReviewApi({
      startVerification: async (_ws, _pr, sections, _tickets, _override, harness) => {
        sent.push(harness);
        return {
          runs: sections.map((section) => ({ section, runId: "r", existing: false })),
          failed: [],
        };
      },
    });
    try {
      const host = await mount(checklist());
      const select = host.querySelector(
        'select[aria-label="Harness for the checks you run"]',
      ) as HTMLSelectElement;
      // Settings' choice comes first and stands for itself; the others follow.
      expect([...select.options].map((o) => o.textContent)).toEqual(["Bedrock", "Claude"]);
      button(row(host, "Risk"), "Run")?.click();
      await waitFor(() => sent.length === 1, "the first start");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        select,
        "claude",
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => select.value === "claude", "the pick to change");
      button(row(host, "Risk"), "Run")?.click();
      await waitFor(() => sent.length === 2, "the second start");
      expect(sent).toEqual([undefined, "claude"]);
    } finally {
      invalidate(VERIFICATION_SETTINGS_KEY);
    }
  });

  it("offers the last run's tickets again, and sends at most five", async () => {
    let named: readonly string[] = [];
    stubReviewApi({
      startVerification: async (_ws, _pr, sections, tickets = []) => {
        named = tickets;
        return {
          runs: sections.map((section) => ({ section, runId: "r", existing: false })),
          failed: [],
        };
      },
    });
    const host = await mount({ ...checklist(), namedTickets: ["ABC-12", "#45"] });
    const input = host.querySelector(
      'input[placeholder="ABC-123, #45 or a ticket link"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("ABC-12, #45");
    typeInto(input, "A-1 B-2 C-3 D-4 E-5 F-6");
    button(row(host, "Claims"), "Run")?.click();
    await waitFor(() => named.length > 0, "the start");
    expect(named).toEqual(["A-1", "B-2", "C-3", "D-4", "E-5"]);
  });

  it("names the checks that couldn't start, while the others run", async () => {
    stubReviewApi({
      startVerification: async () => ({
        runs: [{ section: "risk", runId: "r1", existing: false }],
        failed: [{ section: "tests", error: "no Claude Code here" }],
      }),
    });
    const host = await mount(checklist());
    // Picked by hand, so the picks after the run are what's left of these.
    pick(host, "Performance").click();
    await waitFor(() => !pick(host, "Performance").checked, "the picks to change");
    button(host, `Run picked (${DEFAULT_SECTIONS.length - 1})`)?.click();
    await waitFor(
      () => textOf(host.innerHTML).includes("Couldn't start Test quality: no Claude Code here"),
      "the partial failure",
    );
    // The one that didn't start stays picked for another try; the one that did isn't.
    expect(pick(host, "Test quality").checked).toBe(true);
    expect(pick(host, "Risk").checked).toBe(false);
    expect(pick(host, "Performance").checked).toBe(false);
  });

  it("re-reads the checklist while a check runs, and stops once none is", async () => {
    let reads = 0;
    const report: VerificationReport = { mustRead: [], tests: check };
    stubReviewApi({
      verificationChecklist: async () => {
        reads++;
        return checklist({ items: { tests: { latest: run(), result: run() } }, report });
      },
    });
    const host = await mount(
      checklist({ items: { tests: { latest: run({ status: "running", live: true }) } } }),
    );
    // Past one polling interval, the row shows the run's result.
    await waitFor(
      () => textOf(row(host, "Test quality").innerHTML).includes("Pass"),
      "the finished check",
      8_000,
    );
    const settled = reads;
    // Nothing is running any more, so another interval passes with no read.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(reads).toBe(settled);
  }, 15_000);

  it("shows what each check's last run cost", async () => {
    const host = await mount(
      checklist({
        items: { tests: { latest: run({ costUsd: 0.4242 }), result: run({ costUsd: 0.4242 }) } },
        report: { mustRead: [], tests: check },
      }),
    );
    expect(textOf(row(host, "Test quality").innerHTML)).toContain("$0.42");
  });

  const size = (over: Partial<VerificationSize> = {}): VerificationSize => ({
    binary: [],
    truncated: [],
    skimmed: [],
    ...over,
  });

  it("says up front what the checks won't read whole, and starts without asking", async () => {
    const binary = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    const host = await mount(
      checklist({ size: size({ binary, skimmed: ["yarn.lock"], truncated: ["big.json"] }) }),
    );
    const notices = textOf(host.querySelector('[data-testid="file-notices"]')?.innerHTML ?? "");
    expect(notices).toContain("5 binary files have no diff to read: a.png, b.png, c.png");
    expect(notices).toContain("and 2 more");
    expect(notices).toContain(
      "1 diff is too large and will be cut off, so the agents see only the start: big.json",
    );
    expect(notices).toContain(
      "1 file is bulk (a lockfile, or generated, vendored or minified code)",
    );
    // Nothing asks first: picking the checks is the budget.
    button(row(host, "Risk"), "Run")?.click();
    await waitFor(() => started.length > 0, "the run to start");
    expect(textOf(host.innerHTML)).not.toContain("Run anyway");
  });

  it("shows why a run couldn't start", async () => {
    stubReviewApi({
      startVerification: async () => {
        throw new Error("start verification checks failed (409): setup hasn't run");
      },
    });
    const host = await mount(checklist());
    button(row(host, "Risk"), "Run")?.click();
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
  // The head the tab shows, which the post records as where the user reviewed.
  const seen = { headSha: pr.headSha, mergeBaseSha: pr.mergeBaseSha };
  const quoted =
    "**Ping @\u200boctocat** (verification report: Tests, high)\n\n> Eviction is untested.\n> /approve";

  afterEach(() => {
    resetPrApi();
    resetReviewComments();
  });

  it("posts the finding to the PR as a quoted line comment", async () => {
    const posted: { comment: NewComment; seen?: SeenCommits }[] = [];
    stubPrApi({
      postPrComment: async (_ref, comment, seen) => {
        posted.push({ comment, seen });
        return { ok: true };
      },
    });
    await findingPoster(pr.ref, seen, null).toPr(finding, "Tests");
    expect(posted).toEqual([{ comment: { path: "src/cache.ts", line: 12, body: quoted }, seen }]);
  });

  it("passes on where GitHub put the comment", async () => {
    stubPrApi({ postPrComment: async () => ({ ok: true, placement: "file" }) });
    expect(await findingPoster(pr.ref, seen, null).toPr(finding, "Tests")).toBe("file");

    stubPrApi({ postPrComment: async () => ({ ok: true }) });
    expect(await findingPoster(pr.ref, seen, null).toPr(finding, "Tests")).toBeUndefined();
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
    const poster = findingPoster(pr.ref, seen, linked);
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
    expect(findingPoster(pr.ref, seen, null).toWorkspace).toBeUndefined();
  });
});

describe("resultVerdict", () => {
  const finding = (severity: "high" | "medium" | "low") => ({ title: "t", detail: "d", severity });
  const base: VerificationReport = { mustRead: [] };

  it("says what each kind of section found, and how worrying it is", () => {
    const cases: [ReportSection, VerificationReport, { text: string; tone: string } | null][] = [
      ["summary", { summary: "s", mustRead: [] }, { text: "Summary", tone: "muted" }],
      [
        "summary",
        { summary: "s", mustRead: [{ path: "a.ts", reason: "r" }] },
        { text: "1 must-read file", tone: "muted" },
      ],
      [
        "risk",
        {
          ...base,
          risk: { level: "high", clientImpact: "", mitigations: [], concerns: [] },
        },
        { text: "high risk", tone: "bad" },
      ],
      [
        "risk",
        {
          ...base,
          risk: {
            level: "medium",
            clientImpact: "",
            mitigations: [],
            concerns: [],
            impact: { band: 3 } as never,
          },
        },
        { text: "Impact 3/5", tone: "warn" },
      ],
      [
        "approach",
        { ...base, approach: { rating: "no-simpler", reason: "", alternative: "" } },
        { text: "No simpler way", tone: "good" },
      ],
      [
        "approach",
        { ...base, approach: { rating: "much-simpler", reason: "", alternative: "" } },
        { text: "Much simpler way", tone: "bad" },
      ],
      [
        "approach",
        { ...base, approach: { rating: "unrated", reason: "", alternative: "" } },
        { text: "Not rated", tone: "muted" },
      ],
      [
        "flow",
        { ...base, flow: { title: "", explanation: "", mermaid: "flowchart TD" } },
        { text: "Drawn", tone: "muted" },
      ],
      [
        "flow",
        { ...base, flow: { title: "", explanation: "", mermaid: "" } },
        { text: "Not drawn", tone: "muted" },
      ],
      ["tests", { ...base, tests: check }, { text: "Pass", tone: "good" }],
      [
        "tests",
        { ...base, tests: { status: "issues", findings: [finding("low"), finding("high")] } },
        { text: "2 findings", tone: "bad" },
      ],
      [
        "tests",
        { ...base, tests: { status: "issues", findings: [finding("medium")] } },
        { text: "1 finding", tone: "warn" },
      ],
      ["tests", base, null],
      [
        "changeMap",
        {
          ...base,
          changeMap: {
            intent: "i",
            unmapped: [],
            themes: [
              {
                title: "a",
                description: "",
                risk: "low",
                cohesion: "core",
                question: "",
                files: [],
              },
              {
                title: "b",
                description: "",
                risk: "low",
                cohesion: "outlier",
                question: "?",
                files: [],
              },
            ],
          },
        },
        { text: "2 themes, 1 outlier", tone: "warn" },
      ],
      [
        "changeMap",
        { ...base, changeMap: { intent: "i", unmapped: [], themes: [] } },
        { text: "0 themes", tone: "muted" },
      ],
      [
        "claims",
        {
          ...base,
          claims: {
            items: [
              { claim: "a", source: "title", status: "verified", evidence: "" },
              { claim: "b", source: "title", status: "contradicted", evidence: "" },
            ],
            gaps: [],
          },
        },
        { text: "1 of 2 verified", tone: "bad" },
      ],
      [
        "claims",
        {
          ...base,
          claims: {
            items: [{ claim: "a", source: "title", status: "verified", evidence: "" }],
            gaps: [finding("low")],
          },
        },
        { text: "1 of 1 verified", tone: "warn" },
      ],
      [
        "claims",
        { ...base, claims: { items: [], gaps: [] } },
        { text: "No claims", tone: "muted" },
      ],
      [
        "claims",
        { ...base, claims: { items: [], gaps: [finding("high")] } },
        { text: "1 gap", tone: "warn" },
      ],
      [
        "changeMap",
        { ...base, changeMap: { intent: "i", unmapped: ["a.ts"], themes: [] } },
        { text: "Not mapped", tone: "warn" },
      ],
      ["summary", base, null],
    ];
    for (const [section, report, verdict] of cases) {
      expect(resultVerdict(section, report)).toEqual(verdict as never);
    }
  });
});

describe("evidence from CI, scanners and bots", () => {
  const evidence: VerificationEvidence = {
    headSha: HEAD,
    items: [
      {
        id: "ci-checks",
        theme: "correctness",
        label: "CI checks",
        description: "The PR's CI checks.",
        summary: "1 of 4 failing",
        tone: "bad",
        entries: [
          {
            source: "tests",
            title: "tests: failed",
            detail: "2 tests failed",
            severity: "high",
            path: null,
            line: null,
            url: "https://github.com/octo/repo/actions/runs/1",
          },
          {
            source: "tests",
            title: "orders > sorts",
            detail: "expected 2, got 3",
            severity: "high",
            path: "src/order.test.ts",
            line: 12,
            url: null,
          },
        ],
        hiddenEntries: 0,
        note: null,
      },
      {
        id: "code-scanning",
        theme: "risk",
        label: "Code scanning alerts",
        description: "Open alerts.",
        summary: "Not available",
        tone: "muted",
        entries: [],
        hiddenEntries: 0,
        note: "Code scanning isn't set up for this repository.",
      },
    ],
  };

  const copyReport = async (host: HTMLElement) => {
    (
      host.querySelector(
        'button[aria-label="Copy the whole report as Markdown, to paste into Claude"]',
      ) as HTMLButtonElement
    ).click();
    await waitFor(() => clipboardWrites().length === 1, "the copied report");
    return clipboardWrites()[0] ?? "";
  };

  it("copies CI results for the checkout's commit with the report", async () => {
    const md = await copyReport(await mount(checklist(), evidence));
    expect(md).toContain("### CI checks: 1 of 4 failing");
    expect(md).toContain("- CI: 1 of 4 failing");
  });

  it("leaves CI results for another commit out of the copied report", async () => {
    const md = await copyReport(await mount(checklist(), { ...evidence, headSha: older }));
    expect(md).toContain("## CI, scanners and bots\n\nNo results for this commit.");
    expect(md).not.toContain("1 of 4 failing");
  });

  it("shows each tool's tally under its theme, and its entries on demand", async () => {
    const host = await mount(checklist(), evidence);
    const ci = row(host, "CI checks");
    expect(textOf(ci.innerHTML)).toContain("1 of 4 failing");
    expect(textOf(ci.innerHTML)).not.toContain("expected 2, got 3");
    expect(textOf(row(host, "Code scanning alerts").innerHTML)).toContain(
      "Code scanning isn't set up for this repository.",
    );
    // Nothing to run, so nothing to pick.
    expect(ci.querySelector("input")).toBeNull();

    button(ci, "Show 2")?.click();
    await waitFor(() => textOf(ci.innerHTML).includes("expected 2, got 3"), "the entries");
    expect(textOf(ci.innerHTML)).toContain("src/order.test.ts:12");
    expect(button(ci, "Open")).toBeDefined();
  });

  it("opens the diff at a line an annotation points at, and counts what isn't shown", async () => {
    const opened: unknown[] = [];
    primeCache(verificationKey(pr.id), checklist());
    primeCache(evidenceKey(pr.id), {
      ...evidence,
      items: [{ ...(evidence.items[0] as EvidenceItem), hiddenEntries: 3 }],
    });
    primeCache(changedFilesKey(pr) ?? "", {
      headSha: "",
      mergeBaseSha: "",
      files: [{ path: "src/order.test.ts" }],
    } as never);
    primeCache(treeKey(pr) ?? "", { headSha: "", paths: [] });
    const mounted = await mountForInteraction(
      createElement(VerificationTab, { ctx: { ...ctx, openTab: (tab) => opened.push(tab) } }),
    );
    unmount = mounted.unmount;
    const ci = row(mounted.host, "CI checks");
    button(ci, "Show 5")?.click();
    await waitFor(() => button(ci, "src/order.test.ts:12") !== undefined, "the location link");
    expect(textOf(ci.innerHTML)).toContain("3 more not shown; see the PR.");
    button(ci, "src/order.test.ts:12")?.click();
    expect(opened).toEqual([
      { kind: "diff", prId: pr.id, path: "src/order.test.ts", revealLine: 12 },
    ]);
  });

  it("says why CI results couldn't be read, and still shows the checklist", async () => {
    stubReviewApi({
      verificationEvidence: async () => {
        throw new Error("GitHub rate limit reached");
      },
    });
    primeCache(verificationKey(pr.id), checklist());
    primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
    primeCache(treeKey(pr) ?? "", { headSha: "", paths: [] });
    invalidate(evidenceKey(pr.id));
    const mounted = await mountForInteraction(createElement(VerificationTab, { ctx }));
    unmount = mounted.unmount;
    await waitFor(
      () => textOf(mounted.host.innerHTML).includes("Couldn't read CI results"),
      "the error",
    );
    expect(textOf(mounted.host.innerHTML)).toContain("GitHub rate limit reached");
    expect(row(mounted.host, "Test quality")).toBeDefined();
  });

  it("shows mutation testing with the checks, and opens its tab to run it", async () => {
    const opened: unknown[] = [];
    mutationState = {
      run: {
        id: "m1",
        headSha: older,
        status: "succeeded",
        phase: "done",
        execution: null,
        summary: {
          killed: 3,
          survived: 5,
          timeouts: 0,
          errors: 0,
          uncovered: 0,
          equivalent: 0,
          valid: 8,
          killRate: 0.375,
          verdict: "weak",
          notes: [],
        },
        findings: [],
        error: null,
        costUsd: null,
        startedAt: "",
        finishedAt: null,
        isCurrentHead: false,
        live: false,
      } as MutationRun,
      headSha: HEAD,
      blocked: null,
      sandboxNotes: "",
    };
    primeCache(mutationKey(pr.id), mutationState);
    primeCache(verificationKey(pr.id), checklist());
    primeCache(evidenceKey(pr.id), NO_EVIDENCE);
    primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
    primeCache(treeKey(pr) ?? "", { headSha: "", paths: [] });
    const mounted = await mountForInteraction(
      createElement(VerificationTab, { ctx: { ...ctx, openTab: (tab) => opened.push(tab) } }),
    );
    unmount = mounted.unmount;
    const mutation = row(mounted.host, "Mutation testing");
    expect(textOf(mutation.innerHTML)).toContain("Weak: 3 of 8 mutants caught");
    expect(textOf(mutation.innerHTML)).toContain(`older head (${older.slice(0, 7)})`);
    button(mutation, "Open")?.click();
    expect(opened).toEqual([{ kind: "mutation", prId: pr.id }]);
  });

  it("opens the flow diagram in its own tab, rather than drawing it in the report", async () => {
    const opened: TabSpec[] = [];
    const flow = { title: "How an order is saved", explanation: "", mermaid: "flowchart TD" };
    primeCache(
      verificationKey(pr.id),
      checklist({
        items: { flow: { latest: run(), result: run() } },
        report: { ...goodReport, flow },
      }),
    );
    primeCache(evidenceKey(pr.id), NO_EVIDENCE);
    primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
    primeCache(treeKey(pr) ?? "", { headSha: "", paths: [] });
    const mounted = await mountForInteraction(
      createElement(VerificationTab, { ctx: { ...ctx, openTab: (tab) => opened.push(tab) } }),
    );
    unmount = mounted.unmount;
    expect(textOf(mounted.host.innerHTML)).not.toContain("How an order is saved");
    // Only a section with its own tab offers to open it.
    expect(button(row(mounted.host, "Summary and must-read files"), "Open")).toBeUndefined();
    button(row(mounted.host, "Flow diagram"), "Open")?.click();
    expect(opened).toEqual([{ kind: "diagram", prId: pr.id }]);
  });

  it("offers no tab for a flow diagram that hasn't been drawn", async () => {
    const host = await mount(checklist());
    expect(button(row(host, "Flow diagram"), "Open")).toBeUndefined();
  });

  it("says why mutation testing can't run yet", async () => {
    mutationState = { ...mutationState, blocked: { reason: "Run setup first" } };
    primeCache(mutationKey(pr.id), mutationState);
    const host = await mount(checklist());
    expect(textOf(row(host, "Mutation testing").innerHTML)).toContain("Not run: Run setup first");
  });

  it("says when CI ran on a different commit than the checkout", async () => {
    const host = await mount(checklist(), { ...evidence, headSha: older });
    expect(textOf(host.innerHTML)).toContain(
      `CI results are for ${older.slice(0, 7)}; the checkout is at ${HEAD.slice(0, 7)}.`,
    );
  });

  it("re-reads the evidence when asked", async () => {
    let reads = 0;
    stubReviewApi({
      verificationEvidence: async () => {
        reads++;
        return evidence;
      },
    });
    const host = await mount(checklist(), NO_EVIDENCE);
    button(host, "Re-read CI results")?.click();
    await waitFor(() => textOf(host.innerHTML).includes("1 of 4 failing"), "the re-read evidence");
    expect(reads).toBe(1);
  });
});

describe("the decision panel on the tab", () => {
  it("drafts a finding from an older commit into the summary, not onto its line", async () => {
    const report: VerificationReport = {
      mustRead: [],
      tests: {
        status: "issues",
        findings: [
          {
            title: "No eviction test",
            detail: "d",
            severity: "high",
            path: "src/cache.ts",
            line: 12,
          },
        ],
      },
    };
    const host = await mount(
      checklist({
        items: {
          tests: {
            latest: run({ current: false, headSha: older }),
            result: run({ current: false, headSha: older }),
          },
        },
        report,
      }),
    );
    expect(textOf(host.innerHTML)).toContain("Changes needed");
    button(host, "Request changes")?.click();
    await waitFor(() => textOf(host.innerHTML).includes("No eviction test"), "the draft");
    const draft = [...host.querySelectorAll("li")].find((li) =>
      textOf(li.innerHTML).includes("No eviction test"),
    ) as HTMLElement;
    expect(textOf(draft.innerHTML)).toContain("in the summary");
  });
});
