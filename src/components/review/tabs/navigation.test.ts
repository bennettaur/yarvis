import { describe, expect, it } from "bun:test";
import type { ReviewChangedFile } from "../../../lib/reviewWorkspaces/api";
import type {
  LatestVerification,
  VerificationReport,
} from "../../../lib/reviewWorkspaces/verification";
import { filterPaths } from "../nav/AllFilesTree";
import { changedFileOrder, nextUnviewed } from "./DiffTab";
import { guideFocusTab } from "./GuideTab";
import { mustReadByPath, mustReadFor, reportOf, withViewed } from "./reviewData";

const changed = (path: string): ReviewChangedFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
});

describe("changed file order", () => {
  it("walks files in the order the tree shows them, folders first", () => {
    const order = changedFileOrder([changed("z.ts"), changed("src/b.ts"), changed("src/a.ts")]);
    expect(order).toEqual(["src/a.ts", "src/b.ts", "z.ts"]);
  });

  it("finds the next unviewed file, wrapping round, and none when all are viewed", () => {
    const order = ["a", "b", "c", "d"];
    expect(nextUnviewed(order, "b", new Set(["c"]))).toBe("d");
    expect(nextUnviewed(order, "d", new Set(["c"]))).toBe("a");
    expect(nextUnviewed(order, "a", new Set(["b", "c", "d"]))).toBeNull();
  });
});

describe("guideFocusTab", () => {
  it("opens the focused file's diff at its first line, once per focus", () => {
    const focus = { path: "src/a.ts", startLine: 12, endLine: 20, nonce: 3 };
    expect(guideFocusTab("pr1", focus, 2)).toEqual({
      kind: "diff",
      prId: "pr1",
      path: "src/a.ts",
      revealLine: 12,
    });
    expect(guideFocusTab("pr1", focus, 3)).toBeNull();
    expect(guideFocusTab("pr1", { ...focus, startLine: null }, 2)).toEqual({
      kind: "diff",
      prId: "pr1",
      path: "src/a.ts",
    });
  });
});

describe("must-read lookup", () => {
  const report = {
    mustRead: [{ path: "a.ts", reason: "core logic", lines: { start: 1, end: 9 } }],
  } as VerificationReport;

  it("finds a file's entry, and nothing for a file the report doesn't list", () => {
    expect(mustReadFor(report, "a.ts")?.reason).toBe("core logic");
    expect(mustReadFor(report, "b.ts")).toBeNull();
    expect(mustReadFor(null, "a.ts")).toBeNull();
    expect([...mustReadByPath(report).keys()]).toEqual(["a.ts"]);
  });

  it("reads the last good report, even behind a failed re-run", () => {
    const good = { status: "succeeded", result: report } as never;
    const failed = { status: "failed", result: null } as never;
    const latest = (run: never, lastSucceeded: LatestVerification["lastSucceeded"]) =>
      ({ run, headSha: "h", current: true, lastSucceeded, size: null }) as LatestVerification;
    expect(reportOf(latest(good, { run: good, headSha: "h", current: true }))).toBe(report);
    expect(reportOf(latest(failed, { run: good, headSha: "g", current: false }))).toBe(report);
    expect(reportOf(latest(failed, null))).toBeNull();
    expect(reportOf(null)).toBeNull();
  });
});

describe("withViewed", () => {
  it("adds and removes paths, keeping a sorted list", () => {
    expect(withViewed(["b"], ["a", "c"], true)).toEqual(["a", "b", "c"]);
    expect(withViewed(["a", "b"], ["a"], false)).toEqual(["b"]);
    expect(withViewed(null, ["a"], true)).toEqual(["a"]);
  });
});

describe("filterPaths", () => {
  const paths = ["src/review/tabs/DiffTab.tsx", "src/review/nav/Tree.tsx", "README.md"];

  it("matches every word, in any case and any order", () => {
    expect(filterPaths(paths, "TABS diff")).toEqual(["src/review/tabs/DiffTab.tsx"]);
    expect(filterPaths(paths, "review")).toHaveLength(2);
    expect(filterPaths(paths, "  ")).toEqual([]);
  });

  it("stops at the cap", () => {
    expect(filterPaths(paths, "s", 1)).toHaveLength(1);
  });
});
