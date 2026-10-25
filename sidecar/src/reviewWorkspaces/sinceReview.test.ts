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
  ensureCommit,
  fastForward,
  fileSince,
  filesSince,
  pinReviewedCommit,
  refForReviewed,
  type SinceRange,
  unpinReviewedCommits,
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

  it("keeps body lines that look like file headers", () => {
    const patch = (body: string) =>
      `diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n${body}\n`;
    // A removed SQL comment, a removed YAML document start, an added `++i;`.
    for (const body of ["--- old comment\n+x", "----\n+x", "-a\n+++i;"]) {
      expect(changeSignature(patch(body))).not.toBe(changeSignature(patch("-a\n+x")));
    }
    // The next file's headers are headers again.
    const two = `${patch("-- note")}diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-p\n+q\n`;
    expect(changeSignature(two)).toBe("@@\n-- note\n@@\n-p\n+q");
  });
});

describe("countChanges", () => {
  it("counts body lines, not headers", () => {
    expect(countChanges("--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n-a\n+b\n+c\n")).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("counts body lines that start like headers", () => {
    // Removes the SQL comment `-- old` and the YAML `---`; adds `++i;` and `-- new`.
    const patch = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old\n----\n+++i;\n+-- new\n";
    expect(countChanges(patch)).toEqual({ additions: 2, deletions: 2 });
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

  it("when upstream rewrote the PR's lines, or added the PR's file, the reviewed file shows as it was", async () => {
    const f = fixture();
    f.commit(
      "feature",
      { "src/a.ts": text(withLine(5, "pr")), "src/new.ts": "pr's new file\n" },
      "pr work",
    );
    const reviewed = await f.sync();
    // Upstream edits the PR's very line, and adds a file of the same name.
    f.commit(
      "main",
      { "src/a.ts": text(withLine(5, "upstream")), "src/new.ts": "upstream's file\n" },
      "upstream",
    );
    f.run("checkout", "-q", "feature");
    f.run("reset", "-q", "--hard", "main");
    f.commit(
      "feature",
      { "src/a.ts": text(withLine(5, "pr again")), "src/new.ts": "pr's file, again\n" },
      "pr work, redone",
    );
    const now = await f.sync();

    const result = await since(f, rangeOf(reviewed, now));
    // A merge-file conflict: upstream and the PR both changed line 5.
    const a = await result.view("src/a.ts");
    expect(a.mode).toBe("upstream-included");
    expect(a.original?.content).toBe(text(withLine(5, "pr")));
    expect(a.patch).toContain("-pr\n");
    expect(a.patch).toContain("+pr again");
    // No file at the reviewed merge-base to carry from.
    const added = await result.view("src/new.ts");
    expect(added.mode).toBe("upstream-included");
    expect(added.original?.content).toBe("pr's new file\n");
  });

  it("a file the PR newly touches after a base move shows only the PR's edit", async () => {
    const f = fixture();
    f.commit("feature", { "src/a.ts": text(withLine(5, "pr")) }, "pr work");
    const reviewed = await f.sync();
    f.commit("main", { "src/x.ts": "export const x = 2;\n" }, "upstream");
    f.run("checkout", "-q", "feature");
    f.run("-c", "core.editor=true", "rebase", "-q", "main");
    f.commit("feature", { "src/x.ts": "export const x = 3;\n" }, "pr touches x");
    const now = await f.sync();

    const result = await since(f, rangeOf(reviewed, now));
    expect(result.files).toEqual([{ path: "src/x.ts", status: "added" }]);
    const x = await result.view("src/x.ts");
    expect(x.mode).toBe("carried");
    // The left side is today's base, so upstream's x = 2 isn't the author's.
    expect(x.original?.content).toBe("export const x = 2;\n");
    expect(x.patch).not.toContain("x = 1");
    expect([x.additions, x.deletions]).toEqual([1, 1]);
  });

  it("a file the PR renamed since the review is one modified file, not a revert and an add", async () => {
    const f = fixture();
    f.commit("feature", { "src/a.ts": text(withLine(5, "pr")) }, "pr work");
    const reviewed = await f.sync();
    f.run("checkout", "-q", "feature");
    f.run("mv", "src/a.ts", "src/renamed.ts");
    f.commit("feature", { "src/renamed.ts": text(withLine(6, "more", withLine(5, "pr"))) }, "move");
    const now = await f.sync();

    const result = await since(f, rangeOf(reviewed, now));
    expect(result.files).toEqual([{ path: "src/renamed.ts", status: "modified" }]);
    const moved = await result.view("src/renamed.ts");
    expect(moved.oldPath).toBe("src/a.ts");
    expect(moved.original?.content).toBe(text(withLine(5, "pr")));
    expect(moved.patch).toContain("+more");
    expect([moved.additions, moved.deletions]).toEqual([1, 1]);
  });

  it("a binary file is listed but not read", async () => {
    const f = fixture();
    f.commit("feature", { "src/a.ts": text(withLine(5, "pr")) }, "pr work");
    const reviewed = await f.sync();
    f.commit("feature", { "logo.png": "\u0000\u0001binary\u0000" }, "add a binary");
    const now = await f.sync();

    const entries = await filesSince(f.runners, f.clonePath, rangeOf(reviewed, now), (a, b) =>
      changedFilesBetween(f.runners, f.clonePath, a, b),
    );
    expect(entries).toEqual([expect.objectContaining({ path: "logo.png", binary: true })]);
    const view = await fileSince(f.runners, rangeOf(reviewed, now), entries[0] as never, (sha, p) =>
      readFileAt(f.runners, f.clonePath, sha, p),
    );
    expect(view.patch).toBe("");
    expect([view.additions, view.deletions]).toEqual([0, 0]);
  });

  it("a partial rebase: the kept commit matches its old self, the rewritten one is new", async () => {
    const f = fixture();
    const c1 = f.commit("feature", { "src/a.ts": text(withLine(5, "one")) }, "one");
    const c2 = f.commit(
      "feature",
      { "src/a.ts": text(withLine(15, "two", withLine(5, "one"))) },
      "two",
    );
    const reviewed = await f.sync();
    f.commit("main", { "src/x.ts": "export const x = 2;\n" }, "upstream");
    f.run("checkout", "-q", "feature");
    f.run("-c", "core.editor=true", "rebase", "-q", "main");
    // The top commit is dropped and redone as a different change.
    f.run("reset", "-q", "--hard", "HEAD~1");
    const c1Rebased = f.run("rev-parse", "HEAD").trim();
    const c2Redone = f.commit(
      "feature",
      { "src/a.ts": text(withLine(15, "two, redone", withLine(5, "one"))) },
      "two, redone",
    );
    const now = await f.sync();

    const { commits } = await since(f, rangeOf(reviewed, now));
    expect(commits.commits.map((c) => [c.sha, c.isNew, c.rebasedFrom])).toEqual([
      [c2Redone, true, undefined],
      [c1Rebased, false, c1],
    ]);
    expect(commits.removed.map((c) => c.sha)).toEqual([c2]);
    expect(commits.rebaseMatchSkipped).toBe(false);
  });

  it("too many commits, or blobs, to match a rebase: every rewritten commit reads as new", async () => {
    const f = fixture();
    const c1 = f.commit("feature", { "src/a.ts": text(withLine(15, "pr change")) }, "pr work");
    const reviewed = await f.sync();
    f.commit("main", { "src/a.ts": text(withLine(1, "upstream")) }, "upstream");
    f.run("checkout", "-q", "feature");
    f.run("-c", "core.editor=true", "rebase", "-q", "main");
    const c1Rebased = f.run("rev-parse", "HEAD").trim();
    const range = rangeOf(reviewed, await f.sync());

    // Before anything reads them, the rebased commit's blobs are missing.
    for (const limits of [{ maxBlobs: 0 }, { maxCommits: 0 }]) {
      const result = await commitsSince(f.runners, f.clonePath, range, limits);
      expect(result.rebaseMatchSkipped).toBe(true);
      expect(result.commits).toEqual([expect.objectContaining({ sha: c1Rebased, isNew: true })]);
      expect(result.removed.map((c) => c.sha)).toEqual([c1]);
    }
    const matched = await commitsSince(f.runners, f.clonePath, range);
    expect(matched.rebaseMatchSkipped).toBe(false);
    expect(matched.commits).toEqual([expect.objectContaining({ sha: c1Rebased, rebasedFrom: c1 })]);
  });
});

describe("keeping a reviewed commit", () => {
  it("fetches a commit a force-push dropped, holds it with a ref, and lets it go", async () => {
    const f = fixture();
    const dropped = f.commit("feature", { "src/a.ts": text(withLine(5, "dropped")) }, "dropped");
    f.run("checkout", "-q", "feature");
    f.run("reset", "-q", "--hard", "main");
    f.commit("feature", { "src/a.ts": text(withLine(5, "kept")) }, "kept");
    // Push the dropped commit somewhere the clone never fetches, so the remote has it.
    f.run("push", "-q", f.bare, `${dropped}:refs/keep/dropped`);
    await f.sync();

    // Pinning only holds what the clone has; fetching it is its own step.
    expect(await pinReviewedCommit(f.runners, f.clonePath, "gh-o-r-1", dropped)).toBe(false);
    expect(await ensureCommit(f.runners, f.clonePath, dropped)).toBe(true);
    expect(await pinReviewedCommit(f.runners, f.clonePath, "gh-o-r-1", dropped)).toBe(true);
    expect(sh(f.clonePath, "rev-parse", refForReviewed("gh-o-r-1", dropped)).trim()).toBe(dropped);

    await pinReviewedCommit(f.runners, f.clonePath, "gh-o-r-2", dropped);
    await unpinReviewedCommits(f.runners, f.clonePath, "gh-o-r-1");
    const refs = sh(f.clonePath, "for-each-ref", "--format=%(refname)", "refs/yarvis/");
    expect(refs.trim()).toBe(refForReviewed("gh-o-r-2", dropped));
  });

  it("says false for a commit nobody has, and refuses what isn't a sha", async () => {
    const f = fixture();
    await f.sync();
    expect(await ensureCommit(f.runners, f.clonePath, "b".repeat(40))).toBe(false);
    expect(await ensureCommit(f.runners, f.clonePath, "HEAD")).toBe(false);
    expect(await pinReviewedCommit(f.runners, f.clonePath, "k", "HEAD")).toBe(false);
  });
});
