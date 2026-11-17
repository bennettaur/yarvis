import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrRef } from "../../../lib/pr/types";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import type {
  ReportSection,
  VerificationChecklist,
  VerificationReport,
} from "../../../lib/reviewWorkspaces/verification";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import { changedFilesKey, fileDiffKey, reviewViewedKey, verificationKey } from "./reviewData";
import StoryTab from "./StoryTab";
import type { TabContext, TabSpec } from "./types";

// Azure keeps viewed files on this machine, so marking a chapter read needs no network.
const prRef: PrRef = { provider: "azure", org: "acme", project: "P", repo: "R", prId: 9 };
const pr = {
  id: "story-pr",
  ref: prRef,
  status: "ready",
  worktreeStatus: "ready",
  headSha: "h".repeat(40),
  mergeBaseSha: "b".repeat(40),
} as ReviewWorkspacePr;

let opened: TabSpec[] = [];
const ctx: TabContext = {
  workspaceId: "ws",
  pr,
  prRef,
  diffMode: "split",
  openTab: (spec) => opened.push(spec),
  openSetup: () => {},
};

const report: VerificationReport = {
  mustRead: [],
  changeMap: {
    intent: "Cache user lookups.",
    unmapped: [],
    themes: [
      {
        title: "Cache lookups",
        description: "Reads go through an LRU.",
        risk: "high",
        cohesion: "core",
        question: "",
        files: [{ path: "src/cache.ts" }],
      },
      {
        title: "Bump timeout",
        description: "The HTTP timeout goes to 30s.",
        risk: "low",
        cohesion: "outlier",
        question: "Why the timeout?",
        files: [{ path: "src/http.ts", lines: { start: 2, end: 2 } }],
      },
    ],
  },
  tests: {
    status: "issues",
    findings: [
      { title: "No eviction test", detail: "d", severity: "high", path: "src/cache.ts", line: 2 },
      { title: "Timeout untested", detail: "d", severity: "low", path: "src/http.ts", line: 2 },
      { title: "Unrelated helper", detail: "d", severity: "low", path: "src/http.ts", line: 1 },
    ],
  },
};

const checklist = (r: VerificationReport | null, running = false): VerificationChecklist => ({
  headSha: pr.headSha,
  themes: [],
  items: (["changeMap"] as ReportSection[]).map((section) => ({
    section,
    theme: "understand",
    label: "Change map",
    description: "",
    latest: running
      ? {
          id: "r",
          status: "running",
          live: true,
          headSha: pr.headSha,
          current: true,
          error: null,
          costUsd: null,
          startedAt: "",
          finishedAt: null,
        }
      : null,
    result: r
      ? {
          id: "r",
          status: "succeeded",
          live: false,
          headSha: pr.headSha,
          current: true,
          error: null,
          costUsd: null,
          startedAt: "",
          finishedAt: null,
        }
      : null,
  })),
  report: r,
  size: null,
  namedTickets: [],
});

const patch = (lines: string[]) =>
  ({ path: "", patch: lines.join("\n"), tooLarge: false }) as never;

let unmount = () => {};
afterEach(() => {
  unmount();
  opened = [];
  resetReviewApi();
  localStorage.clear();
});

async function mount(state: VerificationChecklist, viewed: string[] = []) {
  primeCache(verificationKey(pr.id), state);
  primeCache(reviewViewedKey(prRef), viewed);
  primeCache(changedFilesKey(pr) ?? "", {
    headSha: pr.headSha,
    mergeBaseSha: pr.mergeBaseSha,
    files: ["src/cache.ts", "src/http.ts"].map((path) => ({
      path,
      status: "modified",
      additions: 1,
      deletions: 1,
      binary: false,
    })),
  } as never);
  primeCache(
    fileDiffKey(pr, "src/cache.ts") ?? "",
    patch(["@@ -1,2 +1,3 @@", " const a = 1;", "+const cache = new Lru();", " export {};"]),
  );
  primeCache(
    fileDiffKey(pr, "src/http.ts") ?? "",
    patch(["@@ -1,2 +1,2 @@", " get(url,", "-  5000);", "+  30000);"]),
  );
  const mounted = await mountForInteraction(createElement(StoryTab, { ctx }));
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: Element, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

describe("StoryTab", () => {
  it("opens at the first chapter, with its description, its hunks and the report's notes on them", async () => {
    const host = await mount(checklist(report));
    const text = textOf(host.innerHTML);
    expect(text).toContain("Cache user lookups.");
    expect(text).toContain("0 of 2 chapters read");
    expect(text).toContain("Chapter 1 of 2");
    expect(text).toContain("Reads go through an LRU.");
    expect(text).toContain("+const cache = new Lru();");
    expect(text).toContain("Test quality: No eviction test");
    expect(text).not.toContain("Why the timeout?");
  });

  it("marks a chapter's files viewed and moves to the next, which asks its question", async () => {
    const host = await mount(checklist(report));
    button(host, "Mark read and continue").click();
    await waitFor(() => textOf(host.innerHTML).includes("Chapter 2 of 2"), "the next chapter");
    const text = textOf(host.innerHTML);
    expect(text).toContain("1 of 2 chapters read");
    expect(text).toContain("Ask the author: Why the timeout?");
    expect(text).toContain("+  30000);");
    expect(text).toContain("Test quality: Timeout untested");
    expect(text).not.toContain("Unrelated helper");
    expect(button(host, "Mark read")).toBeDefined();
  });

  it("opens at the first chapter not yet read", async () => {
    const host = await mount(checklist(report), ["src/cache.ts"]);
    const text = textOf(host.innerHTML);
    expect(text).toContain("Chapter 2 of 2");
    expect(text).toContain("1 of 2 chapters read");
  });

  it("opens the diff at the theme's first line", async () => {
    const host = await mount(checklist(report), ["src/cache.ts"]);
    button(host, "src/http.ts:2-2").click();
    expect(opened).toEqual([{ kind: "diff", prId: pr.id, path: "src/http.ts", revealLine: 2 }]);
  });

  it("doesn't link a path the PR doesn't change", async () => {
    const stray: VerificationReport = {
      mustRead: [],
      changeMap: {
        intent: "x",
        unmapped: [],
        themes: [
          {
            title: "Stray",
            description: "",
            risk: "low",
            cohesion: "core",
            question: "",
            files: [{ path: "src/other.ts" }],
          },
        ],
      },
    };
    primeCache(fileDiffKey(pr, "src/other.ts") ?? "", patch(["@@ -1 +1 @@", "+x"]));
    const host = await mount(checklist(stray));
    await waitFor(() => textOf(host.innerHTML).includes("src/other.ts"), "the path");
    expect(button(host, "src/other.ts")).toBeUndefined();
  });

  it("shows the first few files of a big chapter, and the rest on request", async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const big: VerificationReport = {
      mustRead: [],
      changeMap: {
        intent: "x",
        unmapped: [],
        themes: [
          { title: "Big", description: "", risk: "low", cohesion: "core", question: "", files },
        ],
      },
    };
    for (const f of files) primeCache(fileDiffKey(pr, f.path) ?? "", patch(["@@ -1 +1 @@", "+x"]));
    const host = await mount(checklist(big));
    expect(textOf(host.innerHTML)).not.toContain("src/f5.ts");
    button(host, "Show 2 more files").click();
    await waitFor(() => textOf(host.innerHTML).includes("src/f6.ts"), "the rest");
  });

  it("opens the full diff from a file's path", async () => {
    const host = await mount(checklist(report));
    button(host, "src/cache.ts").click();
    expect(opened).toEqual([{ kind: "diff", prId: pr.id, path: "src/cache.ts" }]);
  });

  it("offers to write the change map when there is none, and waits for it", async () => {
    let started: readonly string[] = [];
    stubReviewApi({
      startVerification: async (_ws, _pr, sections) => {
        started = sections;
        return { runs: [], failed: [] };
      },
      verificationChecklist: async () => checklist(null, true),
    });
    const host = await mount(checklist(null));
    button(host, "Write the change map").click();
    await waitFor(() => started.length > 0, "the start");
    expect(started).toEqual(["changeMap"]);
    await waitFor(() => textOf(host.innerHTML).includes("Writing the change map"), "the wait");
  });

  it("shows why the change map didn't start", async () => {
    stubReviewApi({
      startVerification: async () =>
        ({ runs: [], failed: [{ section: "changeMap", error: "No checkout" }] }) as never,
      verificationChecklist: async () => checklist(null),
    });
    const host = await mount(checklist(null));
    button(host, "Write the change map").click();
    await waitFor(() => textOf(host.innerHTML).includes("No checkout"), "the error");
  });

  it("shows the error when starting the change map throws", async () => {
    stubReviewApi({
      startVerification: async () => {
        throw new Error("sidecar down");
      },
      verificationChecklist: async () => checklist(null),
    });
    const host = await mount(checklist(null));
    button(host, "Write the change map").click();
    await waitFor(() => textOf(host.innerHTML).includes("sidecar down"), "the error");
  });
});
