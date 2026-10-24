import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  changedFilesBetween,
  ensureReviewClone,
  fetchPr,
  type PrShas,
  type ReviewGit,
  readFileAt,
  reviewGit,
} from "./git.ts";
import {
  changeSignature,
  commitsSince,
  countChanges,
  fastForward,
  fileSince,
  filesSince,
  pinReviewedCommit,
  refForReviewed,
  type SinceRange,
} from "./sinceReview.ts";
import { sh } from "./testRepo.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Twenty numbered lines, so an upstream edit at the top moves a PR hunk lower down. */
const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const withLine = (n: number, value: string, lines = LINES) =>
  lines.map((l, i) => (i === n - 1 ? value : l));

/**
 * A remote with `main` and a PR (`refs/pull/1/head`, branch `feature` in the
 * work repo), and a blobless review clone of it. Commits are made in the work
 * repo and pushed; `sync` fetches the PR again the way a refresh does.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "yarvis-since-"));
  roots.push(root);
  const work = join(root, "work");
  const bare = join(root, "remote.git");
  const clonePath = join(root, "clone");
  mkdirSync(work);
  sh(work, "init", "-q");
  const write = (files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) sh(work, "rm", "-q", path);
      else {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), content);
      }
    }
  };
  const commit = (branch: string, files: Record<string, string | null>, message: string) => {
    sh(work, "checkout", "-q", branch);
    write(files);
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", message);
    return sh(work, "rev-parse", "HEAD").trim();
  };
  write({ "src/a.ts": text(LINES), "src/x.ts": "export const x = 1;\n" });
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "base");
  sh(work, "branch", "feature");
  sh(root, "clone", "-q", "--bare", work, bare);
  sh(bare, "config", "uploadpack.allowFilter", "true");
  sh(bare, "config", "uploadpack.allowAnySHA1InWant", "true");

  const runners: ReviewGit = reviewGit({ allowFileProtocol: true });
  const push = () => {
    sh(work, "push", "-q", "--force", bare, "main:main", "feature:refs/pull/1/head");
  };
  return {
    work,
    bare,
    clonePath,
    runners,
    commit,
    push,
    /** Rewrites `feature` (a rebase or amend), as a force-push would. */
    run: (...args: string[]) => sh(work, ...args),
    async sync(): Promise<PrShas> {
      push();
      await ensureReviewClone(runners, `file://${bare}`, clonePath);
      return fetchPr(runners, clonePath, 1, { kind: "ref", ref: "refs/pull/1/head" }, "main");
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

const rangeOf = (from: PrShas, to: PrShas): SinceRange => ({
  fromHead: from.headSha,
  fromMergeBase: from.mergeBaseSha,
  toHead: to.headSha,
  toMergeBase: to.mergeBaseSha,
});

async function since(f: Fixture, range: SinceRange) {
  const files = await filesSince(f.runners, f.clonePath, range, (from, to) =>
    changedFilesBetween(f.runners, f.clonePath, from, to),
  );
  const commits = await commitsSince(f.runners, f.clonePath, range);
  const view = (path: string) => {
    const entry = files.find((e) => e.path === path);
    if (!entry) throw new Error(`${path} not listed`);
    return fileSince(f.runners, range, entry, (sha, p) =>
      readFileAt(f.runners, f.clonePath, sha, p),
    );
  };
  return {
    files: files.map(({ path, status }) => ({ path, status })),
    commits,
    view,
    fastForward: await fastForward(f.runners, f.clonePath, range),
  };
}

describe("changeSignature", () => {
  it("ignores where a hunk landed but not what it changed", () => {
    const at = (n: number, line: string) =>
      `diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -${n} +${n} @@\n-old\n+${line}\n`;
    expect(changeSignature(at(3, "new"))).toBe(changeSignature(at(13, "new")));
    expect(changeSignature(at(3, "new"))).not.toBe(changeSignature(at(3, "other")));
  });
});

describe("countChanges", () => {
  it("counts body lines, not headers", () => {
    expect(countChanges("--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n-a\n+b\n+c\n")).toEqual({
      additions: 2,
      deletions: 1,
    });
  });
});

describe("since review", () => {
  it("a plain new commit: only the author's new work, and only the new commit is new", async () => {
    const f = fixture();
    const c1 = f.commit("feature", { "src/a.ts": text(withLine(5, "pr one")) }, "first");
    const reviewed = await f.sync();
    const c2 = f.commit(
      "feature",
      { "src/a.ts": text(withLine(15, "pr two", withLine(5, "pr one"))), "src/b.ts": "new\n" },
      "second",
    );
    const now = await f.sync();
    const result = await since(f, rangeOf(reviewed, now));

    expect(result.files).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "added" },
    ]);
    expect(result.fastForward).toBe(true);
    expect(result.commits.commits.map((c) => [c.sha, c.isNew])).toEqual([
      [c2, true],
      [c1, false],
    ]);
    expect(result.commits.removed).toEqual([]);
    const a = await result.view("src/a.ts");
    expect(a.mode).toBe("direct");
    expect(a.patch).toContain("-line 15");
    expect(a.patch).toContain("+pr two");
    expect(a.patch).not.toContain("pr one\n+");
    expect([a.additions, a.deletions]).toEqual([1, 1]);
  });

  it("a rebase onto a moved base: upstream changes are left out", async () => {
    const f = fixture();
    const c1 = f.commit("feature", { "src/a.ts": text(withLine(15, "pr change")) }, "pr work");
    const reviewed = await f.sync();
    // Upstream edits the top of the same file (moving the PR's hunk) and another file.
    f.commit(
      "main",
      { "src/a.ts": text(withLine(1, "upstream")), "src/x.ts": "export const x = 2;\n" },
      "upstream",
    );
    f.run("checkout", "-q", "feature");
    f.run("-c", "core.editor=true", "rebase", "-q", "main");
    const c1Rebased = f.run("rev-parse", "HEAD").trim();
    const rebasedOnly = await f.sync();

    const unchanged = await since(f, rangeOf(reviewed, rebasedOnly));
    expect(unchanged.files).toEqual([]);
    expect(unchanged.fastForward).toBe(false);
    expect(unchanged.commits.commits).toEqual([
      expect.objectContaining({ sha: c1Rebased, isNew: false, rebasedFrom: c1 }),
    ]);
    expect(unchanged.commits.removed).toEqual([]);

    // A new commit on top of the rebase is what shows, carried onto the new base.
    f.commit(
      "feature",
      {
        "src/a.ts": text(
          withLine(18, "pr more", withLine(15, "pr change", withLine(1, "upstream"))),
        ),
      },
      "more pr work",
    );
    const now = await f.sync();
    const result = await since(f, rangeOf(reviewed, now));
    expect(result.files).toEqual([{ path: "src/a.ts", status: "modified" }]);
    const a = await result.view("src/a.ts");
    expect(a.mode).toBe("carried");
    // Both sides carry the upstream line, so it isn't part of the diff.
    expect(a.original?.content).toContain("upstream");
    expect(a.patch).not.toContain("upstream");
    expect(a.patch).toContain("+pr more");
    expect([a.additions, a.deletions]).toEqual([1, 1]);
  });

  it("a merge of the base into the head: the merged-in changes are left out", async () => {
    const f = fixture();
    f.commit("feature", { "src/a.ts": text(withLine(15, "pr change")) }, "pr work");
    const reviewed = await f.sync();
    f.commit(
      "main",
      { "src/a.ts": text(withLine(1, "upstream")), "src/x.ts": "export const x = 2;\n" },
      "upstream",
    );
    f.run("checkout", "-q", "feature");
    f.run("merge", "-q", "--no-edit", "main");
    const merge = f.run("rev-parse", "HEAD").trim();
    const now = await f.sync();

    expect(now.mergeBaseSha).not.toBe(reviewed.mergeBaseSha);
    const result = await since(f, rangeOf(reviewed, now));
    expect(result.files).toEqual([]);
    expect(result.fastForward).toBe(true);
    const flagged = result.commits.commits.find((c) => c.sha === merge);
    expect(flagged).toEqual(expect.objectContaining({ isNew: true }));
    expect(flagged?.parents).toHaveLength(2);
  });

  it("a force-push that rewrites history: the rewritten change shows, the old commit is gone", async () => {
    const f = fixture();
    const c1 = f.commit("feature", { "src/a.ts": text(withLine(5, "first try")) }, "attempt");
    const reviewed = await f.sync();
    f.run("checkout", "-q", "feature");
    f.run("reset", "-q", "--hard", "main");
    const rewritten = f.commit(
      "feature",
      { "src/a.ts": text(withLine(5, "second try")) },
      "attempt",
    );
    const now = await f.sync();

    const result = await since(f, rangeOf(reviewed, now));
    expect(result.files).toEqual([{ path: "src/a.ts", status: "modified" }]);
    expect(result.fastForward).toBe(false);
    expect(result.commits.commits).toEqual([
      expect.objectContaining({ sha: rewritten, isNew: true }),
    ]);
    expect(result.commits.removed.map((c) => c.sha)).toEqual([c1]);
    const a = await result.view("src/a.ts");
    expect(a.patch).toContain("-first try");
    expect(a.patch).toContain("+second try");
  });

  it("a file changed and then reverted reads as reverted", async () => {
    const f = fixture();
    f.commit(
      "feature",
      { "src/a.ts": text(withLine(5, "kept")), "src/x.ts": "export const x = 99;\n" },
      "two changes",
    );
    const reviewed = await f.sync();
    f.commit("feature", { "src/x.ts": "export const x = 1;\n" }, "put x back");
    const now = await f.sync();

    const result = await since(f, rangeOf(reviewed, now));
    expect(result.files).toEqual([{ path: "src/x.ts", status: "reverted" }]);
    const x = await result.view("src/x.ts");
    expect(x.patch).toContain("-export const x = 99;");
    expect(x.patch).toContain("+export const x = 1;");
  });
});

describe("pinReviewedCommit", () => {
  it("fetches a commit a force-push dropped and holds it with a ref", async () => {
    const f = fixture();
    const dropped = f.commit("feature", { "src/a.ts": text(withLine(5, "dropped")) }, "dropped");
    f.run("checkout", "-q", "feature");
    f.run("reset", "-q", "--hard", "main");
    f.commit("feature", { "src/a.ts": text(withLine(5, "kept")) }, "kept");
    // Push the dropped commit somewhere the clone never fetches, so the remote has it.
    f.run("push", "-q", f.bare, `${dropped}:refs/keep/dropped`);
    await f.sync();

    expect(await pinReviewedCommit(f.runners, f.clonePath, "gh-o-r-1", dropped)).toBe(true);
    expect(sh(f.clonePath, "rev-parse", refForReviewed("gh-o-r-1", dropped)).trim()).toBe(dropped);
  });

  it("says false for a commit nobody has, and refuses what isn't a sha", async () => {
    const f = fixture();
    await f.sync();
    expect(await pinReviewedCommit(f.runners, f.clonePath, "k", "b".repeat(40))).toBe(false);
    expect(await pinReviewedCommit(f.runners, f.clonePath, "k", "HEAD")).toBe(false);
  });
});
