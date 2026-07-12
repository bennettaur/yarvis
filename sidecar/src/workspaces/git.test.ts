import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchExists,
  branchSync,
  createWorktree,
  detectDefaultBranch,
  fileDiff,
  type GitRunner,
  type GitRunResult,
  listChangedFiles,
  listFiles,
  removeWorktree,
  updateDefaultBranch,
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
