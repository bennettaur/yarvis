import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunOptions, run, runBytes } from "../workspaces/exec.ts";
import { type GitRunner, removeWorktree } from "../workspaces/git.ts";
import {
  assertSafeRepoPath,
  changedFilesBetween,
  checkoutWorktree,
  ensureReviewClone,
  fetchPr,
  fileDiffBetween,
  hardeningConfig,
  parseTreeEntries,
  prefetchTree,
  prFetchRefspecs,
  readFileAt,
  registerWorktree,
  reviewGit,
  reviewGitEnv,
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

describe("credentials", () => {
  const credentials = { host: "example.com", username: "x-access-token", token: "s3cret-token" };
  const env = reviewGitEnv({ credentials }, "network");
  const home = mkdtempSync(join(tmpdir(), "yarvis-cred-home-"));
  const stored = join(home, "stored-credentials");
  // A user whose global config stores every credential git approves.
  writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = store --file=${stored}\n`);

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  /** Runs `git credential <op>` the way a review git command would. */
  async function credential(op: string, input: string): Promise<string> {
    const proc = Bun.spawn(["git", "credential", op], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return stdout;
  }

  it("keeps the token out of every config value", () => {
    for (const [key, value] of Object.entries(env)) {
      if (key !== "YARVIS_GIT_TOKEN") expect(value).not.toContain("s3cret-token");
    }
  });

  it("answers an https request for its host", async () => {
    const out = await credential("fill", "protocol=https\nhost=example.com\n\n");
    expect(out).toContain("username=x-access-token");
    expect(out).toContain("password=s3cret-token");
  });

  it("answers nothing for a lookalike host or plain http", async () => {
    for (const host of ["example.com.evil.net", "evilexample.com", "example.co"]) {
      expect(await credential("fill", `protocol=https\nhost=${host}\n\n`)).not.toContain(
        "s3cret-token",
      );
    }
    expect(await credential("fill", "protocol=http\nhost=example.com\n\n")).not.toContain(
      "s3cret-token",
    );
  });

  it("clears the user's own helper, so approving stores nothing", async () => {
    await credential(
      "approve",
      "protocol=https\nhost=example.com\nusername=x-access-token\npassword=s3cret-token\n\n",
    );
    expect(existsSync(stored)).toBe(false);
  });
});

/** The git subcommand in an argv, past any `-c key=value` and global flags. */
function subcommand(args: string[]): string {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-c") i++;
    else if (!arg.startsWith("-")) return arg;
  }
  return "";
}

describe("review clone integration", () => {
  const remote = createTestRemote();
  const root = mkdtempSync(join(tmpdir(), "yarvis-review-ws-"));
  const clonePath = join(root, ".review-repos", "github", "o", "r");
  const wsDir = join(root, ".review", "ws1");
  const worktreePath = join(wsDir, "gh-o-r-1");

  // Every command, with the environment it ran with.
  const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
  const record = <T>(spawn: (args: string[], opts: RunOptions) => Promise<T>) => {
    return (args: string[], opts: RunOptions) => {
      calls.push({ args, env: opts.env ?? {} });
      return spawn(args, opts);
    };
  };
  const runners = reviewGit(
    {
      allowFileProtocol: true,
      credentials: { host: "example.invalid", username: "u", token: "tok-123" },
    },
    { run: record(run), runBytes: record(runBytes) },
  );

  afterAll(() => {
    rmSync(remote.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("clones blobless, fetches a fork-style PR ref, and checks out a detached worktree", async () => {
    await ensureReviewClone(runners, remote.url, clonePath);
    expect(sh(clonePath, "config", "remote.origin.partialclonefilter").trim()).toBe("blob:none");

    const shas = await fetchPr(
      runners,
      clonePath,
      1,
      { kind: "ref", ref: "refs/pull/1/head" },
      "main",
    );
    expect(shas.headSha).toBe(sh(remote.bare, "rev-parse", "refs/pull/1/head").trim());
    expect(shas.baseSha).toBe(sh(remote.bare, "rev-parse", "main").trim());
    expect(shas.mergeBaseSha).toBe(sh(remote.work, "rev-parse", "main~1").trim());

    await registerWorktree(runners.local, clonePath, worktreePath, shas.headSha);
    // Registered but not yet checked out: nothing on disk but the `.git` file.
    expect(existsSync(join(worktreePath, "src/new.ts"))).toBe(false);
    // The checkout runs without credentials or lazy fetching, so it only works
    // once the tree's blobs have been fetched explicitly.
    await expect(checkoutWorktree(runners.local, worktreePath, shas.headSha)).rejects.toThrow();
    await prefetchTree(runners, clonePath, shas.headSha);
    await checkoutWorktree(runners.local, worktreePath, shas.headSha);
    expect(sh(worktreePath, "rev-parse", "HEAD").trim()).toBe(shas.headSha);
    expect(sh(worktreePath, "branch", "--show-current").trim()).toBe("");
    expect(existsSync(join(worktreePath, "src/new.ts"))).toBe(true);
  });

  it("lists every changed file with sizes, prefetching all their blobs in one fetch", async () => {
    // A second, fresh clone, so no blob is local yet.
    const fresh = join(root, "fresh");
    await ensureReviewClone(runners, remote.url, fresh);
    const shas = await fetchPr(runners, fresh, 1, { kind: "ref", ref: "refs/pull/1/head" }, "main");

    const traced = reviewGit({ allowFileProtocol: true });
    const tracedEnv = { ...reviewGitEnv({ allowFileProtocol: true }, "network"), GIT_TRACE: "1" };
    const fetches: string[] = [];
    const tracing: GitRunner = async (args, opts) => {
      const result = await run(["git", ...args], { ...opts, env: tracedEnv });
      fetches.push(
        ...result.stderr.split("\n").filter((line) => /built-in: git fetch origin/.test(line)),
      );
      return result;
    };
    const files = await changedFilesBetween(
      { ...traced, network: tracing },
      fresh,
      shas.mergeBaseSha,
      shas.headSha,
    );
    expect(fetches).toHaveLength(1);

    expect(files.map((f) => [f.path, f.status, f.oldPath, f.binary])).toEqual([
      ["big.txt", "added", undefined, false],
      ["docs/gone.md", "deleted", undefined, false],
      ["huge.txt", "added", undefined, false],
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

    // A file the PR didn't touch isn't local; reading it fetches just that blob.
    expect((await readFileAt(traced, fresh, shas.headSha, "README.md"))?.content).toBe("# Test\n");
  });

  it("reads the tree and files by side", async () => {
    const head = sh(clonePath, "rev-parse", "refs/yarvis-review/pr-1/head").trim();
    const base = sh(clonePath, "merge-base", head, "origin/main").trim();

    const tree = await treePaths(runners.local, clonePath, head);
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
      runners.local,
      clonePath,
      base,
      head,
      "src/new.ts",
      "src/old.ts",
    );
    expect(renamed).toContain("rename from src/old.ts");
    expect(renamed).toContain("rename to src/new.ts");
    const modified = await fileDiffBetween(runners.local, clonePath, base, head, "src/a.ts");
    expect(modified).toContain("-export const a = 1;");
    expect(modified).toContain("+export const b = 3;");
  });

  it("resolves an Azure-style merge ref to its second parent", async () => {
    const shas = await fetchPr(
      runners,
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
    await ensureReviewClone(runners, remote.url, clonePath);
    const shas = await fetchPr(
      runners,
      clonePath,
      1,
      { kind: "ref", ref: "refs/pull/1/head" },
      "main",
    );
    expect(shas.headSha).toBe(newHead);
    await registerWorktree(runners.local, clonePath, worktreePath, shas.headSha);
    await prefetchTree(runners, clonePath, shas.headSha);
    await checkoutWorktree(runners.local, worktreePath, shas.headSha);
    expect(sh(worktreePath, "rev-parse", "HEAD").trim()).toBe(newHead);
  });

  it("removes the worktree and keeps the clone", async () => {
    await removeWorktree(runners.local, clonePath, worktreePath, {
      force: true,
      workspaceRoot: wsDir,
    });
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(clonePath, ".git"))).toBe(true);
    expect(sh(clonePath, "worktree", "list", "--porcelain")).not.toContain(worktreePath);
  });

  it("hardened every command, and gave credentials only to network ones", () => {
    const hardening = hardeningConfig(true);
    const network = new Set(["clone", "fetch"]);
    const local = new Set([
      "checkout",
      "worktree",
      "rev-parse",
      "ls-tree",
      "cat-file",
      "merge-base",
      "rev-list",
      "remote",
    ]);
    expect(calls.length).toBeGreaterThan(10);
    for (const { args, env } of calls) {
      const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
        env[`GIT_CONFIG_KEY_${i}`],
        env[`GIT_CONFIG_VALUE_${i}`],
      ]);
      for (const pair of hardening) expect(pairs).toContainEqual(pair);
      const sub = subcommand(args);
      if (local.has(sub)) {
        expect(env.YARVIS_GIT_TOKEN).toBeUndefined();
        expect(env.GIT_NO_LAZY_FETCH).toBe("1");
      }
      if (network.has(sub)) expect(env.YARVIS_GIT_TOKEN).toBe("tok-123");
    }
    // Both kinds actually ran.
    expect(calls.some(({ args }) => subcommand(args) === "checkout")).toBe(true);
    expect(calls.some(({ args }) => subcommand(args) === "fetch")).toBe(true);
  });
});
