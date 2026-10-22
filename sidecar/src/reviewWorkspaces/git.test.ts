import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitRunner, removeWorktree } from "../workspaces/git.ts";
import {
  assertSafeRepoPath,
  changedFilesBetween,
  checkoutWorktree,
  credentialEnv,
  ensureReviewClone,
  fetchPr,
  fileDiffBetween,
  parseTreeEntries,
  prFetchRefspecs,
  readFileAt,
  registerWorktree,
  reviewGit,
  treePaths,
} from "./git.ts";
import { createTestRemote, sh } from "./testRepo.ts";

describe("parseTreeEntries", () => {
  it("reads mode, type, object, size and a path with spaces", () => {
    const out = [
      "100644 blob abc123     42\tdir/a file.txt",
      "160000 commit def456       -\tsub",
      "",
    ].join("\0");
    expect(parseTreeEntries(out)).toEqual([
      { mode: "100644", type: "blob", object: "abc123", size: 42, path: "dir/a file.txt" },
      { mode: "160000", type: "commit", object: "def456", size: null, path: "sub" },
    ]);
  });
});

describe("prFetchRefspecs", () => {
  it("maps the PR head and the base branch to local refs", () => {
    expect(prFetchRefspecs(7, { kind: "ref", ref: "refs/pull/7/head" }, "main")).toEqual([
      "+refs/pull/7/head:refs/yarvis-review/pr-7/head",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    expect(
      prFetchRefspecs(9, { kind: "merge-parent", ref: "refs/pull/9/merge" }, "release/1"),
    ).toEqual([
      "+refs/pull/9/merge:refs/yarvis-review/pr-9/merge",
      "+refs/heads/release/1:refs/remotes/origin/release/1",
    ]);
  });
});

describe("assertSafeRepoPath", () => {
  it.each(["src/a.ts", "a b/c.d", ".github/workflows/ci.yml", "x..y"])("accepts %p", (p) => {
    expect(() => assertSafeRepoPath(p)).not.toThrow();
  });
  it.each(["", "/etc/passwd", "../x", "a/../../b", "a//b", "./a", "a/", "a\0b", "a\nb"])(
    "refuses %p",
    (p) => {
      expect(() => assertSafeRepoPath(p)).toThrow("invalid path");
    },
  );
});

describe("credentialEnv", () => {
  const env = credentialEnv("example.com", "x-access-token", "s3cret-token");

  /** Asks git's credential machinery what it would send, with the review env. */
  async function fill(input: string): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["git", "credential", "fill"], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        GIT_TERMINAL_PROMPT: "0",
        ...env,
      },
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  }

  it("keeps the token out of every config key", () => {
    for (const [key, value] of Object.entries(env)) {
      if (key !== "YARVIS_GIT_TOKEN") expect(value).not.toContain("s3cret-token");
    }
  });

  it("answers an https request for its host", async () => {
    const result = await fill("protocol=https\nhost=example.com\n\n");
    expect(result.stdout).toContain("username=x-access-token");
    expect(result.stdout).toContain("password=s3cret-token");
  });

  it("answers nothing for another host or plain http", async () => {
    for (const input of [
      "protocol=https\nhost=evil.example\n\n",
      "protocol=http\nhost=example.com\n\n",
    ]) {
      const result = await fill(input);
      expect(result.stdout).not.toContain("s3cret-token");
    }
  });
});

describe("review clone integration", () => {
  const remote = createTestRemote();
  const root = mkdtempSync(join(tmpdir(), "yarvis-review-ws-"));
  const clonePath = join(root, ".review-repos", "github", "o", "r");
  const wsDir = join(root, ".review", "ws1");
  const worktreePath = join(wsDir, "gh-o-r-1");
  const runners = reviewGit();

  afterAll(() => {
    rmSync(remote.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("clones blobless, fetches a fork-style PR ref, and checks out a detached worktree", async () => {
    await ensureReviewClone(runners.run, remote.url, clonePath);
    expect(sh(clonePath, "config", "remote.origin.partialclonefilter").trim()).toBe("blob:none");

    const shas = await fetchPr(
      runners.run,
      clonePath,
      1,
      { kind: "ref", ref: "refs/pull/1/head" },
      "main",
    );
    expect(shas.headSha).toBe(sh(remote.bare, "rev-parse", "refs/pull/1/head").trim());
    expect(shas.baseSha).toBe(sh(remote.bare, "rev-parse", "main").trim());
    expect(shas.mergeBaseSha).toBe(sh(remote.work, "rev-parse", "main~1").trim());

    await registerWorktree(runners.run, clonePath, worktreePath, shas.headSha);
    // Registered but not yet checked out: nothing on disk but the `.git` file.
    expect(existsSync(join(worktreePath, "src/new.ts"))).toBe(false);
    await checkoutWorktree(runners.run, worktreePath, shas.headSha);
    expect(sh(worktreePath, "rev-parse", "HEAD").trim()).toBe(shas.headSha);
    expect(sh(worktreePath, "branch", "--show-current").trim()).toBe("");
    expect(existsSync(join(worktreePath, "src/new.ts"))).toBe(true);
  });

  it("lists every changed file with sizes, prefetching all their blobs in one fetch", async () => {
    // A second, fresh clone, so no blob is local yet.
    const fresh = join(root, "fresh");
    await ensureReviewClone(runners.run, remote.url, fresh);
    const shas = await fetchPr(
      runners.run,
      fresh,
      1,
      { kind: "ref", ref: "refs/pull/1/head" },
      "main",
    );

    const traced = reviewGit({ GIT_TRACE: "1" }).run;
    const fetches: string[] = [];
    const tracing: GitRunner = async (args, opts) => {
      const result = await traced(args, opts);
      fetches.push(
        ...result.stderr.split("\n").filter((l) => /built-in: git fetch origin/.test(l)),
      );
      return result;
    };
    const files = await changedFilesBetween(tracing, fresh, shas.mergeBaseSha, shas.headSha);
    expect(fetches).toHaveLength(1);

    expect(files.map((f) => [f.path, f.status, f.oldPath, f.binary])).toEqual([
      ["big.txt", "added", undefined, false],
      ["docs/gone.md", "deleted", undefined, false],
      ["image.bin", "added", undefined, true],
      ["latin1.txt", "added", undefined, false],
      ["src/a.ts", "modified", undefined, false],
      ["src/new.ts", "renamed", "src/old.ts", false],
    ]);
    expect(files.find((f) => f.path === "big.txt")).toMatchObject({ oldSize: 0, newSize: 5000 });
    expect(files.find((f) => f.path === "docs/gone.md")).toMatchObject({ oldSize: 4, newSize: 0 });
    // main's later commit is not part of the PR.
    expect(files.some((f) => f.path === "later.md")).toBe(false);

    // Everything changed is local now: reading it needs no further fetch.
    const missing = sh(
      fresh,
      "rev-list",
      "--objects",
      "--missing=print",
      `${shas.mergeBaseSha}..${shas.headSha}`,
    );
    expect(missing.split("\n").filter((l) => l.startsWith("?"))).toEqual([]);
  });

  it("reads the tree and files by side", async () => {
    const head = sh(clonePath, "rev-parse", "refs/yarvis-review/pr-1/head").trim();
    const base = sh(clonePath, "merge-base", head, "origin/main").trim();

    const tree = await treePaths(runners.run, clonePath, head);
    expect(tree).toContain("src/new.ts");
    expect(tree).not.toContain("src/old.ts");

    expect(await readFileAt(runners, clonePath, head, "src/a.ts")).toEqual({
      content: "export const a = 2;\nexport const b = 3;\n",
      binary: false,
      tooLarge: false,
      size: 40,
    });
    expect((await readFileAt(runners, clonePath, base, "src/a.ts"))?.content).toBe(
      "export const a = 1;\n",
    );
    // A NUL byte, and bytes that aren't UTF-8, both read as binary.
    expect(await readFileAt(runners, clonePath, head, "image.bin")).toMatchObject({
      binary: true,
      content: "",
    });
    expect(await readFileAt(runners, clonePath, head, "latin1.txt")).toMatchObject({
      binary: true,
      content: "",
    });
    expect(await readFileAt(runners, clonePath, head, "big.txt", 1000)).toEqual({
      content: "",
      binary: false,
      tooLarge: true,
      size: 5000,
    });
    // Absent on that side, a directory, or a glob: none of them is a file.
    expect(await readFileAt(runners, clonePath, head, "docs/gone.md")).toBeNull();
    expect(await readFileAt(runners, clonePath, head, "src")).toBeNull();
    expect(await readFileAt(runners, clonePath, head, "src/*.ts")).toBeNull();
    await expect(readFileAt(runners, clonePath, head, "../remote.git/config")).rejects.toThrow(
      "invalid path",
    );

    const renamed = await fileDiffBetween(
      runners.run,
      clonePath,
      base,
      head,
      "src/new.ts",
      "src/old.ts",
    );
    expect(renamed).toContain("rename from src/old.ts");
    expect(renamed).toContain("rename to src/new.ts");
    const modified = await fileDiffBetween(runners.run, clonePath, base, head, "src/a.ts");
    expect(modified).toContain("-export const a = 1;");
    expect(modified).toContain("+export const b = 3;");
  });

  it("resolves an Azure-style merge ref to its second parent", async () => {
    const shas = await fetchPr(
      runners.run,
      clonePath,
      2,
      { kind: "merge-parent", ref: "refs/pull/2/merge" },
      "main",
    );
    expect(shas.headSha).toBe(sh(remote.work, "rev-parse", "feature").trim());
  });

  it("moves the worktree to a new head on refresh", async () => {
    const newHead = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    // Something a setup script might leave behind must not block the move.
    await Bun.write(join(worktreePath, "src/a.ts"), "locally edited\n");
    await ensureReviewClone(runners.run, remote.url, clonePath);
    const shas = await fetchPr(
      runners.run,
      clonePath,
      1,
      { kind: "ref", ref: "refs/pull/1/head" },
      "main",
    );
    expect(shas.headSha).toBe(newHead);
    await registerWorktree(runners.run, clonePath, worktreePath, shas.headSha);
    await checkoutWorktree(runners.run, worktreePath, shas.headSha);
    expect(sh(worktreePath, "rev-parse", "HEAD").trim()).toBe(newHead);
  });

  it("removes the worktree and keeps the clone", async () => {
    await removeWorktree(runners.run, clonePath, worktreePath, {
      force: true,
      workspaceRoot: wsDir,
    });
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(clonePath, ".git"))).toBe(true);
    expect(sh(clonePath, "worktree", "list", "--porcelain")).not.toContain(worktreePath);
  });
});
