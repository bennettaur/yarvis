import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitRunner, fileDiff, listChangedFiles, worktreeStatus } from "./git.ts";
import { checkRepoIntegrity } from "./integrity.ts";
import { ensureBranchRefDirs, resolveAdminName } from "./sandboxPaths.ts";

/** Setup runs with no user config, so a signing or hook setting can't get in the way. */
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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A clone under `.repos/` with one worktree on a `yarvis/` branch, laid out as provisioning does. */
function workspaceRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yarvis-integrity-")));
  roots.push(root);
  const clone = join(root, ".repos", "acme-api");
  mkdirSync(clone, { recursive: true });
  git(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "f"), "a\n");
  git(clone, "add", "f");
  git(clone, "commit", "-qm", "init");
  const worktree = join(root, "ws", "api");
  git(clone, "worktree", "add", "-q", "-b", "yarvis/fix", worktree);
  return { root, clone, worktree };
}

/**
 * What a hijacked session can do with a writable index: stage a fake submodule
 * whose git directory, somewhere it controls, runs a command on `git status`.
 * Returns the file that command creates.
 */
function plantSubmoduleCommand(root: string, worktree: string): string {
  const elsewhere = join(root, "elsewhere");
  git(root, "init", "-q", "--bare", elsewhere);
  git(elsewhere, "config", "core.bare", "false");
  git(elsewhere, "config", "core.worktree", join(worktree, "sub"));
  const marker = join(root, "ran");
  git(elsewhere, "config", "core.fsmonitor", `touch ${marker}; false`);
  const head = git(worktree, "rev-parse", "HEAD").trim();
  git(worktree, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
  mkdirSync(join(worktree, "sub"));
  writeFileSync(join(worktree, "sub", ".git"), `gitdir: ${elsewhere}\n`);
  return marker;
}

describe("hardened git", () => {
  it("doesn't run a command a planted submodule sets, where plain git does", async () => {
    const { root, worktree } = workspaceRepo();
    const marker = plantSubmoduleCommand(root, worktree);

    git(worktree, "status", "--short");
    // The attack is real: unhardened git ran it.
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    await worktreeStatus(defaultGitRunner, worktree);
    await listChangedFiles(defaultGitRunner, worktree, "main");
    await fileDiff(defaultGitRunner, worktree, "main", "f");
    expect(existsSync(marker)).toBe(false);
  });

  it("ignores a replace ref, so a planted one can't change what a commit holds", async () => {
    const { clone } = workspaceRepo();
    const original = git(clone, "rev-parse", "HEAD").trim();
    writeFileSync(join(clone, "f"), "planted\n");
    git(clone, "commit", "-qam", "planted");
    const planted = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "reset", "-q", "--hard", original);
    git(clone, "replace", original, planted);

    const shown = await defaultGitRunner(["show", `${original}:f`], { cwd: clone });
    expect(shown.stdout).toBe("a\n");
  });
});

describe("resolveAdminName", () => {
  it("finds the worktree's admin directory even when git suffixed its name", () => {
    const { root, clone } = workspaceRepo();
    const second = join(root, "ws2", "api");
    git(clone, "worktree", "add", "-q", "-b", "yarvis/other", second);
    expect(resolveAdminName(clone, second)).toBe("api1");
  });

  it("matches from the admin side, so a rewritten .git file can't claim another worktree", () => {
    const { root, clone, worktree } = workspaceRepo();
    const second = join(root, "ws2", "api");
    git(clone, "worktree", "add", "-q", "-b", "yarvis/other", second);
    writeFileSync(join(worktree, ".git"), `gitdir: ${clone}/.git/worktrees/api1\n`);
    expect(resolveAdminName(clone, worktree)).toBe("api");
  });

  it("answers null for a folder no worktree points back at", () => {
    const { root, clone } = workspaceRepo();
    expect(resolveAdminName(clone, join(root, "ws", "nowhere"))).toBeNull();
  });
});

describe("ensureBranchRefDirs", () => {
  it("restores the folders a branch's loose ref needs after refs were packed", () => {
    const { clone } = workspaceRepo();
    git(clone, "pack-refs", "--all");
    const refDir = join(clone, ".git", "refs", "heads", "yarvis");
    if (existsSync(refDir)) rmdirSync(refDir);

    ensureBranchRefDirs({ clonePath: clone, branch: "yarvis/fix", adminName: "api" });
    expect(existsSync(refDir)).toBe(true);
    expect(existsSync(join(clone, ".git", "logs", "refs", "heads", "yarvis"))).toBe(true);
  });
});

describe("checkRepoIntegrity", () => {
  it("finds nothing in a freshly provisioned repo", async () => {
    const { clone, worktree } = workspaceRepo();
    expect(await checkRepoIntegrity(defaultGitRunner, clone, worktree)).toEqual([]);
  });

  it("finds a staged submodule .gitmodules doesn't declare, pointing outside the clone", async () => {
    const { root, clone, worktree } = workspaceRepo();
    const marker = plantSubmoduleCommand(root, worktree);

    const problems = (await checkRepoIntegrity(defaultGitRunner, clone, worktree)).map(
      (f) => f.problem,
    );
    expect(problems).toContain("a submodule entry that .gitmodules doesn't declare");
    expect(problems).toContain(
      "a submodule whose .git points outside the clone's submodule folders",
    );
    // Looking didn't set it off.
    expect(existsSync(marker)).toBe(false);
  });

  it("finds a replace ref", async () => {
    const { clone, worktree } = workspaceRepo();
    const head = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "commit", "-q", "--allow-empty", "-m", "other");
    git(clone, "replace", head, git(clone, "rev-parse", "HEAD").trim());

    const findings = await checkRepoIntegrity(defaultGitRunner, clone, worktree);
    expect(findings).toEqual([
      {
        problem: "a replace ref swaps one commit's content for another",
        where: `refs/replace/${head}`,
      },
    ]);
  });

  it("finds a commondir in the clone's own git folder", async () => {
    const { root, clone, worktree } = workspaceRepo();
    writeFileSync(join(clone, ".git", "commondir"), join(root, "elsewhere"));

    const problems = (await checkRepoIntegrity(defaultGitRunner, clone, worktree)).map(
      (f) => f.problem,
    );
    expect(problems).toContain(
      "the clone's git folder points git at another repository (commondir)",
    );
  });

  it("finds a worktree whose .git file was pointed somewhere else", async () => {
    const { root, clone, worktree } = workspaceRepo();
    git(root, "init", "-q", "--bare", join(root, "elsewhere"));
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(root, "elsewhere")}\n`);

    const problems = (await checkRepoIntegrity(defaultGitRunner, clone, worktree)).map(
      (f) => f.problem,
    );
    expect(problems).toContain("the worktree's .git file points somewhere other than its clone");
  });
});
