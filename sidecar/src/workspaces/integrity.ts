import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalPath, type GitRunner } from "./git.ts";
import { resolveAdminName } from "./sandboxPaths.ts";
import { scanGitDirForSymlinks } from "./symlinkScan.ts";

/**
 * Checks a workspace repo for the changes a hijacked session could make to the
 * clone's git data to get code run outside its sandbox, or to change what other
 * workspaces on the clone merge and push. The sandbox lets a session write the
 * worktree's index and its own refs (`sandboxPaths.ts`), which is enough to
 * stage a fake submodule whose git directory runs a command on the next
 * `git status`. Yarvis's own git is hardened against that (`hardenedGitEnv`)
 * and names refs in full (`remoteRef`), which is what actually protects it; the
 * user's terminal and Claude Code's are not, so this looks for the traces and
 * Yarvis refuses to push or merge for the workspace while any are there.
 *
 * It is best-effort detection, not a barrier: a session that keeps running can
 * change things after a check, or clean up before the next one.
 */

export interface IntegrityFinding {
  /** What was found, for the user. */
  problem: string;
  /** The path or ref it was found at. */
  where: string;
}

/** Enough to name what was found without letting one repo fill the attention item. */
const MAX_FINDINGS = 20;

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The path a gitfile (`gitdir: <path>`) names, resolved against its folder, or null. */
function readGitFile(gitFile: string): string | null {
  try {
    const match = readFileSync(gitFile, "utf8").match(/^gitdir: (.+)$/m);
    return match ? canonicalPath(resolve(dirname(gitFile), match[1]!.trim())) : null;
  } catch {
    return null;
  }
}

/**
 * Runs a read-only git command for the check. A failure returns null, and when
 * the check is `strict` it is also recorded as a finding, since a check that
 * couldn't look must not read as a clean one before a push or merge.
 */
type Reader = (args: string[], cwd: string, what: string) => Promise<string | null>;

function reader(runner: GitRunner, findings: IntegrityFinding[], strict: boolean): Reader {
  return async (args, cwd, what) => {
    const result = await runner(args, { cwd });
    if (result.exitCode === 0) return result.stdout;
    if (strict) findings.push({ problem: `couldn't check ${what}`, where: cwd });
    return null;
  };
}

function lines(out: string | null): string[] {
  return (out ?? "").split("\n").filter(Boolean);
}

/** The paths `.gitmodules` declares submodules at. */
async function declaredSubmodules(read: Reader, worktreePath: string): Promise<Set<string>> {
  if (!existsSync(join(worktreePath, ".gitmodules"))) return new Set();
  // `config -f` reads only that file: it follows no includes and runs nothing.
  const entries = lines(
    await read(
      ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
      worktreePath,
      "the declared submodules",
    ),
  );
  return new Set(entries.map((line) => line.slice(line.indexOf(" ") + 1)));
}

/** The gitlinks (submodule entries) staged in the worktree's index. */
async function stagedGitlinks(read: Reader, worktreePath: string): Promise<string[]> {
  const out = await read(["ls-files", "--stage", "-z"], worktreePath, "the staged submodules");
  return (out ?? "")
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
}

/**
 * Refs that change what a short name means. git resolves `origin/main` by
 * trying `refs/origin/main`, then `refs/tags/origin/main`, then
 * `refs/heads/origin/main`, before the remote-tracking ref, and a bare branch
 * name finds a tag before the branch. Yarvis names refs in full, but the user's
 * own commands don't.
 */
function shadowingRefs(refs: readonly string[]): IntegrityFinding[] {
  const all = new Set(refs);
  const findings: IntegrityFinding[] = [];
  for (const ref of refs) {
    if (ref.startsWith("refs/remotes/")) {
      const short = ref.slice("refs/remotes/".length);
      for (const shadow of [`refs/${short}`, `refs/tags/${short}`, `refs/heads/${short}`]) {
        if (all.has(shadow)) {
          findings.push({
            problem: `a ref that shadows the remote branch ${short}`,
            where: shadow,
          });
        }
      }
    } else if (ref.startsWith("refs/heads/")) {
      const short = ref.slice("refs/heads/".length);
      for (const shadow of [`refs/${short}`, `refs/tags/${short}`]) {
        if (all.has(shadow)) {
          findings.push({ problem: `a ref that shadows the branch ${short}`, where: shadow });
        }
      }
    }
  }
  return findings;
}

/** The ref a HEAD file points at, or null when it holds a commit (a detached HEAD). */
function headRef(headFile: string): string | null {
  try {
    const match = readFileSync(headFile, "utf8").match(/^ref: (\S+)/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Problems in the worktree's own admin directory: a HEAD on a branch another
 * worktree has checked out (git never allows that, so it was written by hand,
 * and a merge there would land on the other workspace's branch), and a stopped
 * rebase whose remaining steps run commands on `git rebase --continue`.
 */
function adminDirFindings(gitDir: string, adminDir: string): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const ours = headRef(join(adminDir, "HEAD"));
  if (ours) {
    const others = [join(gitDir, "HEAD")];
    try {
      for (const name of readdirSync(join(gitDir, "worktrees"))) {
        const dir = join(gitDir, "worktrees", name);
        if (canonicalPath(dir) !== canonicalPath(adminDir)) others.push(join(dir, "HEAD"));
      }
    } catch {
      // No other worktrees to compare with.
    }
    if (others.some((head) => headRef(head) === ours)) {
      findings.push({
        problem: `the worktree is on ${ours}, which another worktree has checked out`,
        where: join(adminDir, "HEAD"),
      });
    }
  }
  try {
    const todo = readFileSync(join(adminDir, "rebase-merge", "git-rebase-todo"), "utf8");
    if (/^\s*(x|exec)\s/m.test(todo)) {
      findings.push({
        problem:
          "a stopped rebase has steps that run commands (if you started it with --exec, finish or abort it)",
        where: join(adminDir, "rebase-merge", "git-rebase-todo"),
      });
    }
  } catch {
    // No rebase stopped in this worktree.
  }
  return findings;
}

/**
 * Inspects one workspace repo. `runner` must be hardened (`defaultGitRunner`
 * is), since the point is that what it inspects may have been tampered with.
 * `strict` counts a git command that fails as a finding; use
 * `checkBeforeWrite` before a push or merge, which also counts a check that
 * throws.
 */
export async function checkRepoIntegrity(
  runner: GitRunner,
  clonePath: string,
  worktreePath: string,
  { strict = false }: { strict?: boolean } = {},
): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  const read = reader(runner, findings, strict);
  // No clone yet (a repo still provisioning) means no git data to tamper with.
  if (!existsSync(join(clonePath, ".git"))) return findings;
  // First, because Yarvis's runner refuses a clone with any, so the git reads
  // below would only report that they couldn't run.
  findings.push(...scanGitDirForSymlinks(join(clonePath, ".git")));
  const gitDir = canonicalPath(join(clonePath, ".git"));

  if (existsSync(join(gitDir, "commondir"))) {
    findings.push({
      problem: "the clone's git folder points git at another repository (commondir)",
      where: join(gitDir, "commondir"),
    });
  }

  const refs = lines(await read(["for-each-ref", "--format=%(refname)"], clonePath, "the refs"));
  for (const ref of refs.filter((r) => r.startsWith("refs/replace/"))) {
    findings.push({ problem: "a replace ref swaps one commit's content for another", where: ref });
  }
  findings.push(...shadowingRefs(refs));

  const adminName = resolveAdminName(clonePath, worktreePath);
  const adminDir = adminName ? join(gitDir, "worktrees", adminName) : null;
  if (!adminDir) {
    findings.push({
      problem: "no worktree registered with the clone points back at this folder",
      where: worktreePath,
    });
  } else {
    const worktreeGit = join(worktreePath, ".git");
    if (existsSync(worktreeGit) && statSync(worktreeGit).isDirectory()) {
      findings.push({ problem: "the worktree has a git folder of its own", where: worktreeGit });
    } else if (readGitFile(worktreeGit) !== canonicalPath(adminDir)) {
      findings.push({
        problem: "the worktree's .git file points somewhere other than its clone",
        where: worktreeGit,
      });
    }
    try {
      const common = readFileSync(join(adminDir, "commondir"), "utf8").trim();
      if (canonicalPath(resolve(adminDir, common)) !== gitDir) {
        findings.push({
          problem: "the worktree's commondir points at another repository",
          where: join(adminDir, "commondir"),
        });
      }
    } catch {
      findings.push({ problem: "the worktree's commondir is missing", where: adminDir });
    }
    if (existsSync(join(adminDir, "config.worktree"))) {
      findings.push({
        problem: "the worktree has its own git config (config.worktree)",
        where: join(adminDir, "config.worktree"),
      });
    }
    findings.push(...adminDirFindings(gitDir, adminDir));
  }

  const declared = await declaredSubmodules(read, worktreePath);
  if (declared.size === 0 && existsSync(join(gitDir, "modules"))) {
    findings.push({
      problem: "the clone has submodule git folders but the repo declares no submodules",
      where: join(gitDir, "modules"),
    });
  }
  const allowedModuleRoots = [join(gitDir, "modules")];
  if (adminDir) allowedModuleRoots.push(join(canonicalPath(adminDir), "modules"));
  for (const path of await stagedGitlinks(read, worktreePath)) {
    if (!declared.has(path)) {
      findings.push({ problem: "a submodule entry that .gitmodules doesn't declare", where: path });
    }
    const subGit = join(worktreePath, path, ".git");
    if (!existsSync(subGit)) continue;
    if (statSync(subGit).isDirectory()) {
      findings.push({ problem: "a submodule with a git folder of its own", where: subGit });
      continue;
    }
    const target = readGitFile(subGit);
    if (!target || !allowedModuleRoots.some((root) => isInside(target, root))) {
      findings.push({
        problem: "a submodule whose .git points outside the clone's submodule folders",
        where: subGit,
      });
    }
  }

  return findings.slice(0, MAX_FINDINGS);
}

/**
 * The check to run right before Yarvis pushes or merges for a workspace. It
 * fails closed: a git command that fails, or a check that throws, is a finding,
 * so the push or merge doesn't go ahead on a check that never looked.
 */
export async function checkBeforeWrite(
  runner: GitRunner,
  clonePath: string,
  worktreePath: string,
): Promise<IntegrityFinding[]> {
  try {
    return await checkRepoIntegrity(runner, clonePath, worktreePath, { strict: true });
  } catch (e) {
    return [
      {
        problem: `the integrity check couldn't run (${e instanceof Error ? e.message : String(e)})`,
        where: worktreePath,
      },
    ];
  }
}

/** One line per finding, for logs, errors and the attention item. */
export function describeFindings(findings: readonly IntegrityFinding[]): string {
  return findings.map((f) => `${f.problem}: ${f.where}`).join("; ");
}
