import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalPath, type GitRunner } from "./git.ts";
import { resolveAdminName } from "./sandboxPaths.ts";

/**
 * Checks a workspace repo for the changes a hijacked session could make to the
 * clone's git data to get code run outside its sandbox, or to change what other
 * workspaces on the clone merge and push. The sandbox lets a session write the
 * worktree's index and its own refs (`sandboxPaths.ts`), which is enough to
 * stage a fake submodule whose git directory runs a command on the next
 * `git status`. Yarvis's own git is hardened against that (`hardenedGitEnv`),
 * but the user's terminal and Claude Code's are not, so this looks for the
 * traces and Yarvis refuses to push or merge for the workspace while any are
 * there.
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

async function lines(runner: GitRunner, args: string[], cwd: string): Promise<string[] | null> {
  const result = await runner(args, { cwd });
  if (result.exitCode !== 0) return null;
  return result.stdout.split("\n").filter(Boolean);
}

/** The paths `.gitmodules` declares submodules at. */
async function declaredSubmodules(runner: GitRunner, worktreePath: string): Promise<Set<string>> {
  if (!existsSync(join(worktreePath, ".gitmodules"))) return new Set();
  // `config -f` reads only that file: it follows no includes and runs nothing.
  const entries = await lines(
    runner,
    ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    worktreePath,
  );
  return new Set((entries ?? []).map((line) => line.slice(line.indexOf(" ") + 1)));
}

/** The gitlinks (submodule entries) staged in the worktree's index. */
async function stagedGitlinks(runner: GitRunner, worktreePath: string): Promise<string[]> {
  const result = await runner(["ls-files", "--stage", "-z"], { cwd: worktreePath });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
}

/**
 * Inspects one workspace repo. `runner` must be hardened (`defaultGitRunner`
 * is), since the point is that what it inspects may have been tampered with.
 */
export async function checkRepoIntegrity(
  runner: GitRunner,
  clonePath: string,
  worktreePath: string,
): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  // No clone yet (a repo still provisioning) means no git data to tamper with.
  if (!existsSync(join(clonePath, ".git"))) return findings;
  const gitDir = canonicalPath(join(clonePath, ".git"));

  if (existsSync(join(gitDir, "commondir"))) {
    findings.push({
      problem: "the clone's git folder points git at another repository (commondir)",
      where: join(gitDir, "commondir"),
    });
  }

  for (const ref of (await lines(
    runner,
    ["for-each-ref", "--format=%(refname)", "refs/replace/"],
    clonePath,
  )) ?? []) {
    findings.push({ problem: "a replace ref swaps one commit's content for another", where: ref });
  }

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
  }

  const declared = await declaredSubmodules(runner, worktreePath);
  if (declared.size === 0 && existsSync(join(gitDir, "modules"))) {
    findings.push({
      problem: "the clone has submodule git folders but the repo declares no submodules",
      where: join(gitDir, "modules"),
    });
  }
  const allowedModuleRoots = [join(gitDir, "modules")];
  if (adminDir) allowedModuleRoots.push(join(canonicalPath(adminDir), "modules"));
  for (const path of await stagedGitlinks(runner, worktreePath)) {
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

/** One line per finding, for logs, errors and the attention item. */
export function describeFindings(findings: readonly IntegrityFinding[]): string {
  return findings.map((f) => `${f.problem}: ${f.where}`).join("; ");
}
