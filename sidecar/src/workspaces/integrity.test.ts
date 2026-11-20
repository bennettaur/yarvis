import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultGitRunner,
  fileDiff,
  type GitRunner,
  listChangedFiles,
  mergeBaseIntoWorktree,
  worktreeStatus,
} from "./git.ts";
import { checkBeforeWrite, checkRepoIntegrity } from "./integrity.ts";
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

/** Like `workspaceRepo`, but cloned from a bare remote, so `origin/main` exists. */
function clonedWorkspaceRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yarvis-integrity-")));
  roots.push(root);
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(root, "seed");
  git(root, "clone", "-q", remote, seed);
  writeFileSync(join(seed, "f"), "a\n");
  git(seed, "add", "f");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const clone = join(root, ".repos", "acme-api");
  git(root, "clone", "-q", remote, clone);
  const worktree = join(root, "ws", "api");
  git(clone, "worktree", "add", "-q", "-b", "yarvis/fix", worktree, "origin/main");
  return { root, seed, clone, worktree };
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

  it("reaches the git a declared submodule starts, even when .gitmodules says not to ignore it", async () => {
    const { root, worktree } = workspaceRepo();
    const child = join(root, "child");
    git(root, "init", "-q", "-b", "main", child);
    git(child, "commit", "-q", "--allow-empty", "-m", "c");
    git(worktree, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub");
    git(worktree, "config", "-f", ".gitmodules", "submodule.sub.ignore", "none");
    const marker = join(root, "ran");
    git(join(worktree, "sub"), "config", "core.fsmonitor", `touch ${marker}; false`);
    writeFileSync(join(worktree, "sub", "dirty"), "x\n");

    git(worktree, "status", "--short");
    // The child's fsmonitor is real: plain git ran it.
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    // The env alone, with no --ignore-submodules on the command line, still
    // reaches the child.
    await defaultGitRunner(["status", "--short"], { cwd: worktree });
    await defaultGitRunner(["diff", "HEAD"], { cwd: worktree });
    await worktreeStatus(defaultGitRunner, worktree);
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

  it("refuses a worktree path that is a symlink, which could stand in for another worktree", () => {
    const { root, clone, worktree } = workspaceRepo();
    const link = join(root, "ws", "linked");
    symlinkSync(worktree, link);
    expect(resolveAdminName(clone, link)).toBeNull();
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
    // And the branch's remote-tracking ref's, so a push from the sandbox can update it.
    expect(existsSync(join(clone, ".git", "refs", "remotes", "origin", "yarvis"))).toBe(true);
    expect(existsSync(join(clone, ".git", "logs", "refs", "remotes", "origin", "yarvis"))).toBe(
      true,
    );
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

  it("finds a tag that shadows a remote branch, which Yarvis's merge ignores", async () => {
    const { seed, clone, worktree } = clonedWorkspaceRepo();
    writeFileSync(join(seed, "f"), "real\n");
    git(seed, "commit", "-qam", "real");
    git(seed, "push", "-q", "origin", "HEAD:main");
    git(clone, "fetch", "-q", "origin");

    // What a session could do with writable tags and objects: a commit of its
    // own, named so that `origin/main` finds it first.
    writeFileSync(join(worktree, "f"), "planted\n");
    git(worktree, "commit", "-qam", "planted");
    const planted = git(worktree, "rev-parse", "HEAD").trim();
    git(worktree, "reset", "-q", "--hard", "HEAD~1");
    git(clone, "tag", "origin/main", planted);
    // The shadow is real for anything that names the short ref.
    expect(git(clone, "rev-parse", "origin/main").trim()).toBe(planted);

    expect(await mergeBaseIntoWorktree(defaultGitRunner, worktree, "main")).toEqual({
      result: "merged",
    });
    expect(readFileSync(join(worktree, "f"), "utf8")).toBe("real\n");

    const findings = await checkRepoIntegrity(defaultGitRunner, clone, worktree);
    expect(findings).toContainEqual({
      problem: "a ref that shadows the remote branch origin/main",
      where: "refs/tags/origin/main",
    });
  });

  it("finds a worktree put on a branch another worktree has checked out", async () => {
    const { clone, worktree } = workspaceRepo();
    writeFileSync(join(clone, ".git", "worktrees", "api", "HEAD"), "ref: refs/heads/main\n");

    const problems = (await checkRepoIntegrity(defaultGitRunner, clone, worktree)).map(
      (f) => f.problem,
    );
    expect(problems).toContain(
      "the worktree is on refs/heads/main, which another worktree has checked out",
    );
  });

  it("finds a stopped rebase whose remaining steps run commands", async () => {
    const { clone, worktree } = workspaceRepo();
    const rebaseDir = join(clone, ".git", "worktrees", "api", "rebase-merge");
    mkdirSync(rebaseDir);
    writeFileSync(join(rebaseDir, "git-rebase-todo"), "pick abc123 one\nexec make deploy\n");

    const problems = (await checkRepoIntegrity(defaultGitRunner, clone, worktree)).map(
      (f) => f.problem,
    );
    expect(problems).toContain(
      "a stopped rebase has steps that run commands (if you started it with --exec, finish or abort it)",
    );
  });
});

describe("checkBeforeWrite", () => {
  it("counts a git command that fails as a finding, so a push doesn't go ahead unchecked", async () => {
    const { clone, worktree } = workspaceRepo();
    const failing: GitRunner = async () => ({ stdout: "", stderr: "boom", exitCode: 128 });

    expect(await checkRepoIntegrity(failing, clone, worktree)).toEqual([]);
    const findings = await checkBeforeWrite(failing, clone, worktree);
    expect(findings.map((f) => f.problem)).toContain("couldn't check the refs");
  });

  it("counts a check that throws as a finding", async () => {
    const { clone, worktree } = workspaceRepo();
    const throwing: GitRunner = async () => {
      throw new Error("spawn failed");
    };
    expect(await checkBeforeWrite(throwing, clone, worktree)).toEqual([
      { problem: "the integrity check couldn't run (spawn failed)", where: worktree },
    ]);
  });

  it("finds nothing in a clean repo", async () => {
    const { clone, worktree } = workspaceRepo();
    expect(await checkBeforeWrite(defaultGitRunner, clone, worktree)).toEqual([]);
  });
});
