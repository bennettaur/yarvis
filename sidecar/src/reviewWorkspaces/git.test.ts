import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWorktree } from "../workspaces/git.ts";
import {
  assertSafeRepoPath,
  changedFilesBetween,
  credentialEnv,
  ensureDetachedWorktree,
  ensureReviewClone,
  fetchPr,
  fileDiffBetween,
  looksBinary,
  parseChangedFiles,
  parseTreeEntries,
  prFetchRefspecs,
  readFileAt,
  reviewGit,
  treePaths,
} from "./git.ts";
import { createTestRemote, sh } from "./testRepo.ts";

describe("parseChangedFiles", () => {
  it("joins name-status and numstat, keeping renames, deletions and binaries", () => {
    const nameStatus = [
      "M",
      "src/a.ts",
      "R087",
      "src/old.ts",
      "src/new.ts",
      "D",
      "gone.md",
      "A",
      "img.bin",
      "",
    ].join("\0");
    const numstat = [
      "2\t1\tsrc/a.ts",
      "1\t1\t",
      "src/old.ts",
      "src/new.ts",
      "0\t1\tgone.md",
      "-\t-\timg.bin",
      "",
    ].join("\0");
    expect(parseChangedFiles(nameStatus, numstat)).toEqual([
      { path: "gone.md", status: "deleted", additions: 0, deletions: 1, binary: false },
      { path: "img.bin", status: "added", additions: 0, deletions: 0, binary: true },
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 1, binary: false },
      {
        path: "src/new.ts",
        oldPath: "src/old.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        binary: false,
      },
    ]);
  });

  it("keeps a tab inside a filename as part of the path", () => {
    const files = parseChangedFiles("M\0a\tb.txt\0", "1\t0\ta\tb.txt\0");
    expect(files).toEqual([
      { path: "a\tb.txt", status: "modified", additions: 1, deletions: 0, binary: false },
    ]);
  });

  it("has no cap on the number of files", () => {
    const paths = Array.from({ length: 250 }, (_, i) => `f${i}.ts`);
    const nameStatus = paths.flatMap((p) => ["A", p]).join("\0");
    const numstat = paths.map((p) => `1\t0\t${p}`).join("\0");
    expect(parseChangedFiles(`${nameStatus}\0`, `${numstat}\0`)).toHaveLength(250);
  });
});

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

describe("looksBinary", () => {
  it("flags NUL bytes and invalid UTF-8, not ordinary text", () => {
    expect(looksBinary(new TextEncoder().encode("héllo\n"))).toBe(false);
    expect(looksBinary(new Uint8Array([104, 0, 105]))).toBe(true);
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(true);
  });
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
  const git = reviewGit();

  afterAll(() => {
    rmSync(remote.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("clones blobless, fetches a fork-style PR ref, and checks out a detached worktree", async () => {
    await ensureReviewClone(git.run, remote.url, clonePath);
    expect(sh(clonePath, "config", "remote.origin.partialclonefilter").trim()).toBe("blob:none");

    const shas = await fetchPr(
      git.run,
      clonePath,
      1,
      { kind: "ref", ref: "refs/pull/1/head" },
      "main",
    );
    expect(shas.headSha).toBe(sh(remote.bare, "rev-parse", "refs/pull/1/head").trim());
    expect(shas.baseSha).toBe(sh(remote.bare, "rev-parse", "main").trim());
    expect(shas.mergeBaseSha).toBe(sh(remote.work, "rev-parse", "main~1").trim());

    await ensureDetachedWorktree(git.run, clonePath, worktreePath, shas.headSha);
    expect(sh(worktreePath, "rev-parse", "HEAD").trim()).toBe(shas.headSha);
    expect(sh(worktreePath, "branch", "--show-current").trim()).toBe("");
    expect(existsSync(join(worktreePath, "src/new.ts"))).toBe(true);

    const files = await changedFilesBetween(git.run, clonePath, shas.mergeBaseSha, shas.headSha);
    expect(files.map((f) => [f.path, f.status, f.oldPath, f.binary])).toEqual([
      ["big.txt", "added", undefined, false],
      ["docs/gone.md", "deleted", undefined, false],
      ["image.bin", "added", undefined, true],
      ["src/a.ts", "modified", undefined, false],
      ["src/new.ts", "renamed", "src/old.ts", false],
    ]);
    // main's later commit is not part of the PR.
    expect(files.some((f) => f.path === "later.md")).toBe(false);

    const tree = await treePaths(git.run, clonePath, shas.headSha);
    expect(tree).toContain("src/new.ts");
    expect(tree).not.toContain("src/old.ts");

    expect(await readFileAt(git, clonePath, shas.headSha, "src/a.ts")).toEqual({
      content: "export const a = 2;\nexport const b = 3;\n",
      binary: false,
      tooLarge: false,
      size: 40,
    });
    expect((await readFileAt(git, clonePath, shas.mergeBaseSha, "src/a.ts"))?.content).toBe(
      "export const a = 1;\n",
    );
    expect(await readFileAt(git, clonePath, shas.headSha, "image.bin")).toMatchObject({
      binary: true,
      content: "",
    });
    expect(await readFileAt(git, clonePath, shas.headSha, "big.txt", 1000)).toEqual({
      content: "",
      binary: false,
      tooLarge: true,
      size: 5000,
    });
    // Absent on that side, a directory, or a glob: none of them is a file.
    expect(await readFileAt(git, clonePath, shas.headSha, "docs/gone.md")).toBeNull();
    expect(await readFileAt(git, clonePath, shas.headSha, "src")).toBeNull();
    expect(await readFileAt(git, clonePath, shas.headSha, "src/*.ts")).toBeNull();
    await expect(readFileAt(git, clonePath, shas.headSha, "../remote.git/config")).rejects.toThrow(
      "invalid path",
    );

    const renamed = await fileDiffBetween(
      git.run,
      clonePath,
      shas.mergeBaseSha,
      shas.headSha,
      "src/new.ts",
      "src/old.ts",
    );
    expect(renamed).toContain("rename from src/old.ts");
    expect(renamed).toContain("rename to src/new.ts");
    const modified = await fileDiffBetween(
      git.run,
      clonePath,
      shas.mergeBaseSha,
      shas.headSha,
      "src/a.ts",
    );
    expect(modified).toContain("-export const a = 1;");
    expect(modified).toContain("+export const b = 3;");
  });

  it("resolves an Azure-style merge ref to its second parent", async () => {
    const shas = await fetchPr(
      git.run,
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
    await ensureReviewClone(git.run, remote.url, clonePath);
    const shas = await fetchPr(
      git.run,
      clonePath,
      1,
      { kind: "ref", ref: "refs/pull/1/head" },
      "main",
    );
    expect(shas.headSha).toBe(newHead);
    await ensureDetachedWorktree(git.run, clonePath, worktreePath, shas.headSha);
    expect(sh(worktreePath, "rev-parse", "HEAD").trim()).toBe(newHead);
  });

  it("removes the worktree and keeps the clone", async () => {
    await removeWorktree(git.run, clonePath, worktreePath, { force: true, workspaceRoot: wsDir });
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(clonePath, ".git"))).toBe(true);
    expect(sh(clonePath, "worktree", "list", "--porcelain")).not.toContain(worktreePath);
  });
});
