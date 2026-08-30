import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addExistingBranchWorktree,
  branchExists,
  branchSync,
  createWorktree,
  detectDefaultBranch,
  existingWorktree,
  fetchBranch,
  fileDiff,
  type GitRunner,
  type GitRunResult,
  listChangedFiles,
  listFiles,
  listRemoteBranches,
  mergeBaseIntoWorktree,
  pushBranch,
  removeWorktree,
  updateDefaultBranch,
  worktreeStatus,
} from "./git.ts";

/** A scripted GitRunner that records calls and answers based on the args. */
function fakeRunner(handler: (args: string[]) => Partial<GitRunResult>): {
  runner: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    const r = handler(args);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  };
  return { runner, calls };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("detectDefaultBranch", () => {
  it("reads and strips the origin/HEAD symbolic ref", async () => {
    const { runner, calls } = fakeRunner((args) =>
      args[0] === "symbolic-ref" ? { stdout: "origin/main\n" } : {},
    );
    expect(await detectDefaultBranch(runner, "/repo")).toBe("main");
    expect(calls[0]).toEqual(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  });

  it("sets origin/HEAD then retries when it is missing", async () => {
    let firstRead = true;
    const { runner, calls } = fakeRunner((args) => {
      if (args[0] === "symbolic-ref") {
        if (firstRead) {
          firstRead = false;
          return { exitCode: 1 };
        }
        return { stdout: "origin/trunk\n" };
      }
      return {};
    });
    expect(await detectDefaultBranch(runner, "/repo")).toBe("trunk");
    expect(calls.some((c) => c[0] === "remote" && c[1] === "set-head")).toBe(true);
  });

  it("returns null when the ref can't be determined", async () => {
    const { runner } = fakeRunner(() => ({ exitCode: 1 }));
    expect(await detectDefaultBranch(runner, "/repo")).toBeNull();
  });
});

describe("updateDefaultBranch", () => {
  it("fetches the branch with prune and no checkout", async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await updateDefaultBranch(runner, "/repo", "main");
    expect(calls[0]).toEqual(["fetch", "origin", "main", "--prune"]);
  });
});

describe("branchExists", () => {
  it("maps a zero exit to true and non-zero to false", async () => {
    const present = fakeRunner(() => ({ exitCode: 0 }));
    expect(await branchExists(present.runner, "/repo", "feature")).toBe(true);
    const absent = fakeRunner(() => ({ exitCode: 1 }));
    expect(await branchExists(absent.runner, "/repo", "feature")).toBe(false);
  });
});

describe("createWorktree", () => {
  it("prunes then adds a worktree branched from origin/<base>", async () => {
    const parent = mkdtempSync(join(tmpdir(), "yarvis-wt-"));
    tmpDirs.push(parent);
    const { runner, calls } = fakeRunner(() => ({}));
    const worktreePath = join(parent, "service-a");
    await createWorktree(runner, "/repo", worktreePath, "yarvis/task", "main");
    expect(calls[0]).toEqual(["worktree", "prune"]);
    expect(calls[1]).toEqual(["worktree", "add", "-b", "yarvis/task", worktreePath, "origin/main"]);
  });
});

describe("existingWorktree", () => {
  /** A runner answering `worktree list` with the given porcelain output. */
  const listing = (stdout: string) =>
    fakeRunner((args) => (args[0] === "worktree" && args[1] === "list" ? { stdout } : {}));

  it("prunes before listing, so a folder deleted out of band reads as free", async () => {
    const { runner, calls } = listing("");
    expect(await existingWorktree(runner, "/repo", "/ws/service-a")).toBeNull();
    expect(calls[0]).toEqual(["worktree", "prune"]);
    expect(calls[1]).toEqual(["worktree", "list", "--porcelain"]);
  });

  it("answers with the branch checked out at the path", async () => {
    const { runner } = listing(
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n" +
        "worktree /ws/service-a\nHEAD def\nbranch refs/heads/yarvis/task\n\n",
    );
    expect(await existingWorktree(runner, "/repo", "/ws/service-a")).toEqual({
      branch: "yarvis/task",
    });
  });

  it("reports a detached worktree as having no branch", async () => {
    const { runner } = listing("worktree /ws/service-a\nHEAD def\ndetached\n\n");
    expect(await existingWorktree(runner, "/repo", "/ws/service-a")).toEqual({ branch: null });
  });

  it("returns null for a path no worktree is registered at", async () => {
    const { runner } = listing("worktree /ws/other\nHEAD def\nbranch refs/heads/other\n\n");
    expect(await existingWorktree(runner, "/repo", "/ws/service-a")).toBeNull();
  });

  it("matches through a symlinked path, which is what git reports", async () => {
    // The workspaces root sits under /var on macOS, which git resolves to
    // /private/var — a plain string compare would call the path free and then
    // fail on `worktree add`.
    const parent = mkdtempSync(join(tmpdir(), "yarvis-wt-"));
    tmpDirs.push(parent);
    const worktreePath = join(parent, "service-a");
    mkdirSync(worktreePath);
    const { runner } = listing(
      `worktree ${realpathSync(worktreePath)}\nHEAD def\nbranch refs/heads/yarvis/task\n\n`,
    );
    expect(await existingWorktree(runner, "/repo", worktreePath)).toEqual({
      branch: "yarvis/task",
    });
  });

  it("names an unrelated directory occupying the path rather than letting the add fail", async () => {
    const parent = mkdtempSync(join(tmpdir(), "yarvis-wt-"));
    tmpDirs.push(parent);
    const worktreePath = join(parent, "service-a");
    mkdirSync(worktreePath);
    writeFileSync(join(worktreePath, "stray"), "");
    const { runner } = listing("");
    expect(existingWorktree(runner, "/repo", worktreePath)).rejects.toThrow("remove it");
  });

  it("treats an empty leftover folder as free, which git accepts", async () => {
    const parent = mkdtempSync(join(tmpdir(), "yarvis-wt-"));
    tmpDirs.push(parent);
    const worktreePath = join(parent, "service-a");
    mkdirSync(worktreePath);
    const { runner } = listing("");
    expect(await existingWorktree(runner, "/repo", worktreePath)).toBeNull();
  });
});

describe("fetchBranch", () => {
  it("fetches a single branch with no checkout", async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await fetchBranch(runner, "/repo", "feat/login");
    expect(calls[0]).toEqual(["fetch", "origin", "feat/login"]);
  });
});

describe("listRemoteBranches", () => {
  it("strips the origin/ prefix and drops origin/HEAD", async () => {
    const { runner, calls } = fakeRunner(() => ({
      stdout: "origin/HEAD\norigin/main\norigin/feat/login\n",
    }));
    expect(await listRemoteBranches(runner, "/repo")).toEqual(["main", "feat/login"]);
    expect(calls[0]).toEqual(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  });
});

describe("addExistingBranchWorktree", () => {
  it("prunes then adds a worktree on the bare branch name", async () => {
    const parent = mkdtempSync(join(tmpdir(), "yarvis-wt-"));
    tmpDirs.push(parent);
    const { runner, calls } = fakeRunner(() => ({}));
    const worktreePath = join(parent, "service-a");
    await addExistingBranchWorktree(runner, "/repo", worktreePath, "feat/login");
    expect(calls[0]).toEqual(["worktree", "prune"]);
    expect(calls[1]).toEqual(["worktree", "add", worktreePath, "feat/login"]);
  });
});

describe("removeWorktree", () => {
  it("omits --force by default", async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await removeWorktree(runner, "/repo", "/wt", { force: false });
    expect(calls[0]).toEqual(["worktree", "remove", "/wt"]);
  });

  it("includes --force when asked", async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await removeWorktree(runner, "/repo", "/wt", { force: true });
    expect(calls[0]).toEqual(["worktree", "remove", "--force", "/wt"]);
  });
});

describe("listFiles", () => {
  it("splits tracked files into a list", async () => {
    const { runner } = fakeRunner(() => ({ stdout: "a.ts\nb/c.ts\n" }));
    expect(await listFiles(runner, "/wt")).toEqual(["a.ts", "b/c.ts"]);
  });
});

describe("listChangedFiles", () => {
  it("diffs against the merge-base start ref, not origin's tip", async () => {
    const { runner, calls } = fakeRunner((args) => {
      if (args[0] === "merge-base") return { stdout: "abc123\n" };
      return {};
    });
    await listChangedFiles(runner, "/wt", "main");
    expect(calls[0]).toEqual(["merge-base", "origin/main", "HEAD"]);
    // Both the name-status and numstat diffs use the resolved start ref.
    expect(calls.filter((c) => c[0] === "diff").every((c) => c[2] === "abc123")).toBe(true);
  });

  it("falls back to origin/<base> when there is no merge-base", async () => {
    const { runner, calls } = fakeRunner((args) => {
      if (args[0] === "merge-base") return { exitCode: 1 };
      return {};
    });
    await listChangedFiles(runner, "/wt", "main");
    expect(calls.filter((c) => c[0] === "diff").every((c) => c[2] === "origin/main")).toBe(true);
  });

  it("merges name-status, numstat, and untracked files", async () => {
    const { runner } = fakeRunner((args) => {
      if (args[0] === "merge-base") return { stdout: "abc123\n" };
      if (args[1] === "--name-status") {
        return { stdout: "M\tsrc/a.ts\nA\tsrc/b.ts\nR100\told.ts\tnew.ts\n" };
      }
      if (args[1] === "--numstat") {
        return { stdout: "3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n2\t2\tnew.ts\n-\t-\tbin.png\n" };
      }
      if (args[0] === "ls-files") return { stdout: "src/c.ts\n" };
      return {};
    });

    const changed = await listChangedFiles(runner, "/wt", "main");
    const byPath = new Map(changed.map((c) => [c.path, c]));

    expect(byPath.get("src/a.ts")).toEqual({
      path: "src/a.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
    });
    expect(byPath.get("src/b.ts")?.status).toBe("added");
    expect(byPath.get("new.ts")?.status).toBe("renamed");
    // Binary files report "-" counts as zero.
    expect(byPath.get("bin.png")).toEqual({
      path: "bin.png",
      status: "modified",
      additions: 0,
      deletions: 0,
    });
    expect(byPath.get("src/c.ts")?.status).toBe("untracked");
  });
});

describe("fileDiff", () => {
  it("diffs a tracked file against the merge-base start ref with a guarded pathspec", async () => {
    const { runner, calls } = fakeRunner((args) => {
      if (args[0] === "merge-base") return { stdout: "abc123\n" };
      return args[0] === "diff" ? { stdout: "@@ -1 +1 @@\n-old\n+new\n" } : {};
    });
    expect(await fileDiff(runner, "/wt", "main", "src/a.ts")).toContain("+new");
    expect(calls[0]).toEqual(["merge-base", "origin/main", "HEAD"]);
    expect(calls[1]).toEqual(["diff", "abc123", "--", "src/a.ts"]);
  });

  it("falls back to a --no-index diff for an untracked file", async () => {
    const { runner, calls } = fakeRunner((args) => {
      if (args[0] === "merge-base") return { stdout: "abc123\n" };
      if (args.includes("--no-index"))
        return { stdout: "@@ -0,0 +1 @@\n+brand new\n", exitCode: 1 };
      return { stdout: "" }; // tracked diff is empty for an untracked path
    });
    const patch = await fileDiff(runner, "/wt", "main", "new.ts");
    expect(patch).toContain("+brand new");
    expect(calls[2]).toEqual(["diff", "--no-index", "--", "/dev/null", "new.ts"]);
  });

  it("throws when --no-index fails for a real reason (exit > 1)", async () => {
    const { runner } = fakeRunner((args) => {
      if (args[0] === "merge-base") return { stdout: "abc123\n" };
      if (args.includes("--no-index")) return { stderr: "boom", exitCode: 128 };
      return { stdout: "" };
    });
    await expect(fileDiff(runner, "/wt", "main", "missing.ts")).rejects.toThrow("boom");
  });
});

describe("branchSync", () => {
  it("counts ahead/behind versus the remote branch when it has been pushed", async () => {
    const { runner } = fakeRunner((args) => {
      if (args[0] === "rev-parse") return { exitCode: 0 }; // origin/<branch> exists
      if (args[0] === "rev-list") {
        const range = args[2];
        if (range === "HEAD..origin/main") return { stdout: "2\n" }; // base moved on
        if (range === "origin/feature..HEAD") return { stdout: "3\n" }; // to push
        if (range === "HEAD..origin/feature") return { stdout: "1\n" }; // to pull
      }
      return {};
    });
    expect(await branchSync(runner, "/wt", "feature", "main")).toEqual({
      ahead: 3,
      behind: 1,
      baseBehind: 2,
      hasRemote: true,
    });
  });

  it("counts commits over the base and reports behind=0 before the branch is pushed", async () => {
    const { runner } = fakeRunner((args) => {
      if (args[0] === "rev-parse") return { exitCode: 1 }; // no origin/<branch> yet
      if (args[0] === "rev-list") {
        const range = args[2];
        if (range === "HEAD..origin/main") return { stdout: "0\n" };
        if (range === "origin/main..HEAD") return { stdout: "4\n" };
      }
      return {};
    });
    expect(await branchSync(runner, "/wt", "feature", "main")).toEqual({
      ahead: 4,
      behind: 0,
      baseBehind: 0,
      hasRemote: false,
    });
  });
});

describe("worktreeStatus", () => {
  /** Answers the non-`status` probes the way a clean worktree on `feature` does. */
  const cleanWorktree = (args: string[]) => {
    if (args[0] === "symbolic-ref") return { stdout: "feature\n" };
    if (args[0] === "rev-parse" && args[1] === "--git-path") return { stdout: "" };
    if (args[0] === "rev-parse") return { exitCode: 1 }; // no sequencer ref
    return {};
  };

  it("reports modified tracked files and the branch they are on", async () => {
    const { runner, calls } = fakeRunner((args) => {
      // `-z` output: NUL-separated entries, no trailing newline.
      if (args[0] === "status") return { stdout: " M src/app.ts\0A  src/new.ts\0" };
      return cleanWorktree(args);
    });
    expect(await worktreeStatus(runner, "/wt")).toEqual({
      dirtyFiles: ["src/app.ts", "src/new.ts"],
      branch: "feature",
      inProgress: null,
    });
    // Untracked files never block a merge, so git is asked not to walk them.
    expect(calls[0]).toEqual(["status", "--porcelain", "-z", "--untracked-files=no"]);
  });

  it("keeps paths git would have quoted, and takes the new path of a rename", async () => {
    // Under `-z` a rename is "R  <new>\0<original>\0" — the original comes
    // second, the reverse of the quoted format — and nothing is quoted, so a
    // path with a space or a non-ASCII character arrives intact.
    const { runner } = fakeRunner((args) => {
      if (args[0] === "status") {
        return { stdout: "R  src/new name.ts\0src/old.ts\0 M src/café.ts\0" };
      }
      return cleanWorktree(args);
    });
    const status = await worktreeStatus(runner, "/wt");
    expect(status.dirtyFiles).toEqual(["src/new name.ts", "src/café.ts"]);
  });

  it("reports a detached HEAD as no branch", async () => {
    const { runner } = fakeRunner((args) => {
      if (args[0] === "status") return { stdout: "" };
      if (args[0] === "symbolic-ref") return { exitCode: 1 }; // detached
      if (args[0] === "rev-parse" && args[1] === "--git-path") return { stdout: "" };
      if (args[0] === "rev-parse") return { exitCode: 1 };
      return {};
    });
    expect((await worktreeStatus(runner, "/wt")).branch).toBeNull();
  });

  it("names the sequencer operation already under way", async () => {
    // A cherry-pick stopped on a conflict is as unsafe to merge into as a merge.
    for (const [ref, expected] of [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
      ["REBASE_HEAD", "rebase"],
    ] as const) {
      const { runner } = fakeRunner((args) => {
        if (args[0] === "status") return { stdout: "" };
        if (args[0] === "symbolic-ref") return { stdout: "feature\n" };
        if (args[0] === "rev-parse" && args[1] === "--git-path") return { stdout: "" };
        if (args[0] === "rev-parse") return { exitCode: args[3] === ref ? 0 : 1 };
        return {};
      });
      expect((await worktreeStatus(runner, "/wt")).inProgress).toBe(expected);
    }
  });
});

describe("mergeBaseIntoWorktree", () => {
  it("merges the remote base branch, never a local ref", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: "Merge made by the 'ort' strategy.\n" }));
    expect(await mergeBaseIntoWorktree(runner, "/wt", "main")).toEqual({ result: "merged" });
    expect(calls[0]).toEqual(["merge", "--no-edit", "origin/main"]);
  });

  it("distinguishes an already-merged base from a real merge", async () => {
    const { runner } = fakeRunner(() => ({ stdout: "Already up to date.\n" }));
    expect(await mergeBaseIntoWorktree(runner, "/wt", "main")).toEqual({ result: "up-to-date" });
  });

  it("reports the conflicted files and leaves the merge in the worktree", async () => {
    const { runner, calls } = fakeRunner((args) => {
      if (args[0] === "merge") return { exitCode: 1, stderr: "Automatic merge failed" };
      if (args[0] === "diff") return { stdout: "src/app.ts\nREADME.md\n" };
      return {};
    });
    expect(await mergeBaseIntoWorktree(runner, "/wt", "main")).toEqual({
      result: "conflict",
      files: ["src/app.ts", "README.md"],
    });
    // The conflict markers are the point; nothing may undo them.
    expect(calls.some((c) => c.includes("--abort"))).toBe(false);
  });

  it("throws when the merge failed for a reason other than conflicts", async () => {
    const { runner } = fakeRunner((args) => {
      if (args[0] === "merge") {
        return { exitCode: 128, stderr: "fatal: refusing to merge unrelated histories" };
      }
      return {}; // no unmerged paths
    });
    await expect(mergeBaseIntoWorktree(runner, "/wt", "main")).rejects.toThrow(
      "refusing to merge unrelated histories",
    );
  });
});

describe("pushBranch", () => {
  it("pushes the branch and sets it as upstream", async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await pushBranch(runner, "/wt", "yarvis/fix-the-widget");
    expect(calls[0]).toEqual(["push", "--set-upstream", "origin", "yarvis/fix-the-widget"]);
  });

  it("throws with git's own message when the push is rejected", async () => {
    const { runner } = fakeRunner(() => ({ exitCode: 1, stderr: "! [rejected] fetch first" }));
    await expect(pushBranch(runner, "/wt", "feature")).rejects.toThrow("fetch first");
  });
});
