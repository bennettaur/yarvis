import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitRunner } from "./git.ts";
import { checkRepoIntegrity } from "./integrity.ts";
import { ghRunner } from "./stack.ts";
import { commonGitDirFor, scanGitDirForSymlinks, setSymlinkHandler } from "./symlinkScan.ts";

const GIT_TEST_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_TEST_ENV },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const roots: string[] = [];
afterEach(() => {
  setSymlinkHandler(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A clone with two workspaces' worktrees on their own branches, a remote-tracking
 * ref for each, and a file and a folder of the test's own for a symlink to point at.
 */
function sharedClone() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yarvis-symlink-")));
  roots.push(root);
  const clone = join(root, ".repos", "acme-api");
  mkdirSync(clone, { recursive: true });
  git(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "f"), "a\n");
  git(clone, "add", "f");
  git(clone, "commit", "-qm", "init");
  const ours = join(root, "ws-a", "api");
  const theirs = join(root, "ws-b", "api");
  git(clone, "worktree", "add", "-q", "-b", "yarvis/a", ours);
  git(clone, "worktree", "add", "-q", "-b", "yarvis/b", theirs);
  const head = git(clone, "rev-parse", "HEAD").trim();
  mkdirSync(join(clone, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(clone, ".git", "refs", "remotes", "origin", "main"), `${head}\n`);
  const target = join(root, "target.txt");
  writeFileSync(target, "keep\n");
  const targetDir = join(root, "target-dir");
  mkdirSync(targetDir);
  return { root, clone, ours, theirs, gitDir: join(clone, ".git"), target, targetDir };
}

/** The admin directory git made for a worktree, found from its `gitdir` file. */
function adminDirOf(gitDir: string, worktree: string): string {
  for (const name of readdirSync(join(gitDir, "worktrees"))) {
    const dir = join(gitDir, "worktrees", name);
    if (readFileSync(join(dir, "gitdir"), "utf8").trim() === join(worktree, ".git")) return dir;
  }
  throw new Error(`no admin dir for ${worktree}`);
}

function branchTip(clone: string, branch: string): string {
  return git(clone, "rev-parse", `refs/heads/${branch}`).trim();
}

describe("the symlink scan", () => {
  it("finds nothing in a freshly provisioned clone, and lets git run", async () => {
    const { clone, ours, gitDir } = sharedClone();
    expect(scanGitDirForSymlinks(gitDir)).toEqual([]);
    expect((await defaultGitRunner(["status", "--short"], { cwd: ours })).exitCode).toBe(0);
    expect((await defaultGitRunner(["rev-parse", "HEAD"], { cwd: clone })).exitCode).toBe(0);
  });

  it("maps a worktree to its clone's git folder", () => {
    const { ours, gitDir } = sharedClone();
    expect(commonGitDirFor(ours)).toBe(gitDir);
    expect(commonGitDirFor(join(ours, "nowhere"))).toBeNull();
  });

  it("refuses a clone with a symlink under refs/remotes, leaving other branches alone", async () => {
    const { clone, ours, gitDir, targetDir } = sharedClone();
    const before = branchTip(clone, "yarvis/b");
    const link = join(gitDir, "refs", "remotes", "origin", "x");
    symlinkSync(targetDir, link);
    const reported: string[][] = [];
    setSymlinkHandler((_dir, findings) => reported.push(findings.map((f) => f.where)));

    expect(scanGitDirForSymlinks(gitDir).map((f) => f.where)).toEqual([link]);
    for (const cwd of [clone, ours]) {
      const result = await defaultGitRunner(["fetch", "origin"], { cwd });
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain("symlink");
    }
    expect(reported).toEqual([[link], [link]]);
    expect(readdirSync(targetDir)).toEqual([]);
    expect(branchTip(clone, "yarvis/b")).toBe(before);
  });

  it("refuses a worktree whose MERGE_MSG is a symlink, leaving the file it points at alone", async () => {
    const { ours, gitDir, target } = sharedClone();
    const link = join(adminDirOf(gitDir, ours), "MERGE_MSG");
    symlinkSync(target, link);

    expect(scanGitDirForSymlinks(gitDir).map((f) => f.where)).toEqual([link]);
    const result = await defaultGitRunner(["merge", "--no-edit", "refs/heads/main"], { cwd: ours });
    expect(result.exitCode).toBe(128);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
  });

  it("refuses a worktree whose reflog folder is a symlink", async () => {
    const { ours, gitDir, targetDir } = sharedClone();
    const logs = join(adminDirOf(gitDir, ours), "logs");
    rmSync(logs, { recursive: true, force: true });
    symlinkSync(targetDir, logs);

    expect(scanGitDirForSymlinks(gitDir).map((f) => f.where)).toEqual([logs]);
    expect((await defaultGitRunner(["status"], { cwd: ours })).exitCode).toBe(128);
    expect(readdirSync(targetDir)).toEqual([]);
  });

  it("refuses a clone whose worktree admin folder was swapped for a symlink", async () => {
    const { root, clone, theirs, gitDir } = sharedClone();
    const admin = adminDirOf(gitDir, theirs);
    const moved = join(root, "moved-admin");
    renameSync(admin, moved);
    symlinkSync(moved, admin);

    expect(scanGitDirForSymlinks(gitDir).map((f) => f.where)).toEqual([admin]);
    expect((await defaultGitRunner(["worktree", "prune"], { cwd: clone })).exitCode).toBe(128);
  });

  it("refuses for gh too, since gh stack drives git in the worktree", async () => {
    const { ours, gitDir, targetDir } = sharedClone();
    symlinkSync(targetDir, join(gitDir, "refs", "remotes", "origin", "x"));
    // Refused before gh is started, so this never reaches the network.
    const result = await ghRunner(undefined)(["stack", "view"], { cwd: ours, timeoutMs: 5_000 });
    expect(result.exitCode).toBe(128);
  });

  it("is reported by the integrity check", async () => {
    const { clone, ours, gitDir, target } = sharedClone();
    const link = join(adminDirOf(gitDir, ours), "MERGE_MSG");
    symlinkSync(target, link);
    const findings = await checkRepoIntegrity(defaultGitRunner, clone, ours);
    expect(findings).toContainEqual({ problem: "a symlink in the clone's git data", where: link });
  });
});
