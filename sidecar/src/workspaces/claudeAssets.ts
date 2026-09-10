import type { Dirent } from "node:fs";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

/**
 * Copies each workspace repo's `.claude/skills` and `.claude/agents` entries up
 * into the workspace root's own `.claude` directory.
 *
 * Claude Code only discovers skills and agents under the directory it starts in,
 * and a workspace root sits one level above the repos, so a repo's own skills
 * are invisible to the session. The `skills.paths`/`agents.paths` settings keys
 * look like the fix but load nothing (checked against CLI 2.1.263: a skill
 * reachable only through `paths` is absent from the session; the same skill
 * under `.claude/skills` loads). Copying is what actually makes them available.
 *
 * Split out from the workspace service so the naming rules are unit testable
 * without a filesystem.
 */

const KINDS = ["skills", "agents"] as const;

export type AssetKind = (typeof KINDS)[number];

/**
 * Records the copies we made so the next provision removes exactly those and
 * leaves anything the user put in the workspace root by hand alone.
 */
const MANIFEST_FILE = ".yarvis-copied.json";

export interface AssetEntry {
  /** Name on disk: a skill directory, or an agent `.md` file. */
  entry: string;
  /**
   * What Claude Code addresses the entry by — a skill's directory name, an
   * agent's declared `name`. Collisions are decided on this, not on the
   * filename: two repos can ship `reviewer.md` and `code-reviewer.md` that both
   * declare `name: reviewer`, and only one of them can answer to it.
   */
  id: string;
}

export interface RepoAssets {
  /** The repo's worktree directory name, prepended to disambiguate a clash. */
  prefix: string;
  /** Absolute path of the repo's `.claude/<kind>` directory. */
  sourceDir: string;
  entries: AssetEntry[];
}

export interface PlannedCopy extends AssetEntry {
  prefix: string;
  sourceDir: string;
  /** Name the entry gets in the workspace root — `entry`, or a prefixed form. */
  name: string;
  /** Identity the copy answers to — `id`, prefixed alongside `name`. */
  declaredId: string;
}

/**
 * Decides what each repo's entries are called once they all live in one
 * directory. An identity offered by more than one repo, or already claimed by an
 * entry we don't manage, is prefixed with the repo's directory name — for *every*
 * repo offering it, not just the losers, so the outcome doesn't depend on the
 * order the repos arrive in. A contested identity renames the copy on disk too,
 * since a file renamed but still declaring the old identity would collide
 * exactly as before; a contested *filename* alone renames only the file, because
 * two agents whose identities never clashed still have to fit in one directory
 * and renaming one would break whatever referenced it. An entry whose prefixed
 * name is taken too is reported as skipped rather than silently overwriting the
 * copy that got there first.
 */
export function planAssetCopies(
  repos: RepoAssets[],
  taken: readonly AssetEntry[] = [],
): { copies: PlannedCopy[]; skipped: PlannedCopy[] } {
  const idOffers = new Map<string, number>();
  const nameOffers = new Map<string, number>();
  for (const repo of repos) {
    for (const { entry, id } of repo.entries) {
      idOffers.set(id, (idOffers.get(id) ?? 0) + 1);
      nameOffers.set(entry, (nameOffers.get(entry) ?? 0) + 1);
    }
  }

  const takenIds = new Set(taken.map((e) => e.id));
  const takenNames = new Set(taken.map((e) => e.entry));
  const claimedNames = new Set(takenNames);
  const claimedIds = new Set(takenIds);
  const copies: PlannedCopy[] = [];
  const skipped: PlannedCopy[] = [];

  for (const { prefix, sourceDir, entries } of repos) {
    for (const { entry, id } of entries) {
      const idContested = (idOffers.get(id) ?? 0) > 1 || takenIds.has(id);
      const nameContested = (nameOffers.get(entry) ?? 0) > 1 || takenNames.has(entry);
      const planned: PlannedCopy = {
        prefix,
        sourceDir,
        entry,
        id,
        name: idContested || nameContested ? `${prefix}-${entry}` : entry,
        declaredId: idContested ? `${prefix}-${id}` : id,
      };
      if (claimedNames.has(planned.name) || claimedIds.has(planned.declaredId)) {
        skipped.push(planned);
        continue;
      }
      claimedNames.add(planned.name);
      claimedIds.add(planned.declaredId);
      copies.push(planned);
    }
  }

  return { copies, skipped };
}

/**
 * Entries of `dir` that are shaped like the kind asks for, or none when it is
 * missing or unreadable. Dotfiles are skipped — neither a skill nor an agent is
 * one, and our own manifest lives in the directory we copy into.
 *
 * A symlink is refused outright. `cpSync` preserves one rather than following
 * it, so the copy would still point at the source's target: writing the copy's
 * frontmatter would then rewrite that target — any file the user can write —
 * and reading through it would leave the copied tree reaching outside the
 * workspace. The entries come out of a checked-out repo, so this is reachable
 * by anyone who can push to one.
 */
function readEntries(dir: string, kind: AssetKind): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith(".") && !e.isSymbolicLink())
    .filter((e) => (kind === "skills" ? e.isDirectory() : e.isFile() && e.name.endsWith(".md")))
    .map((e) => e.name);
}

/** The `name` an agent definition declares, or none when it declares one. */
function declaredName(file: string): string | null {
  try {
    const fields = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    const name = fields?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "");
    return name || null;
  } catch {
    return null;
  }
}

/** Entries of an asset directory paired with the identity each answers to. */
function readAssetEntries(dir: string, kind: AssetKind): AssetEntry[] {
  return readEntries(dir, kind).map((entry) => ({
    entry,
    id: kind === "skills" ? entry : (declaredName(`${dir}/${entry}`) ?? entry.replace(/\.md$/, "")),
  }));
}

/** What each kind's directory holds after a sync, keyed by kind. */
export type CopiedAssets = Record<AssetKind, string[]>;

function emptyManifest(): CopiedAssets {
  return { skills: [], agents: [] };
}

/**
 * The disambiguating prefix for a repo: its worktree directory name, reduced to
 * the character set Claude Code accepts in a skill name — a repo called
 * `docs.site` would otherwise produce a copy that exists but never loads.
 */
function prefixFor(worktree: string): string {
  return (
    basename(worktree)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

/** True for a name that stays inside the directory it is resolved against. */
function isPlainEntryName(name: string): boolean {
  return (
    name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")
  );
}

/**
 * Reads the previous run's manifest. Anything but a plain entry name is dropped:
 * it can only come from a hand-edited file, and every name here is about to be
 * handed to `rm -r` — `..` alone would take the whole `.claude` directory,
 * settings and all.
 */
function readManifest(file: string): CopiedAssets {
  const manifest = emptyManifest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[workspaces] unreadable ${file}:`, e);
    }
    return manifest;
  }
  if (!parsed || typeof parsed !== "object") return manifest;
  for (const kind of KINDS) {
    const names = (parsed as Record<string, unknown>)[kind];
    if (!Array.isArray(names)) continue;
    manifest[kind] = names.filter(
      (name): name is string => typeof name === "string" && isPlainEntryName(name),
    );
  }
  return manifest;
}

/**
 * Points a renamed copy's frontmatter `name` at the name it now answers to. A
 * skill is addressed by its directory name and an agent by its frontmatter
 * `name`, so this is cosmetic for skills and load-bearing for agents — without
 * it two same-named agents from different repos still collide after the copy.
 */
function alignFrontmatterName(copiedPath: string, kind: AssetKind, declared: string): void {
  const file = kind === "skills" ? `${copiedPath}/SKILL.md` : copiedPath;
  try {
    // The copy's own SKILL.md can still be a symlink even when the directory
    // holding it was not, and writing through one rewrites its target.
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return;
    const content = readFileSync(file, "utf8");
    const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
    if (!match) return;
    const [block, opener, fields, closingFence] = match as unknown as [
      string,
      string,
      string,
      string,
    ];
    // A definition that declares no name is given one rather than left to
    // whatever the loader falls back to, so the copies are distinct either way.
    const renamed = /^name:/m.test(fields)
      ? fields.replace(/^name:.*$/m, `name: ${declared}`)
      : `name: ${declared}\n${fields}`;
    if (renamed === fields) return;
    writeFileSync(file, `${opener}${renamed}${closingFence}${content.slice(block.length)}`);
  } catch (e) {
    console.error(`[workspaces] could not rename ${kind} entry in ${file}:`, e);
  }
}

/**
 * Names a copy that hides one of the user's own global definitions. Claude Code
 * prefers the project's over `~/.claude`'s, so a repo shipping a skill the user
 * already has by that name quietly takes its place for the whole workspace —
 * worth a line in the log, since nothing else would say so. `globalRoot` is a
 * parameter so a test can point it somewhere other than the running user's home.
 */
export function warnOnShadowedGlobals(
  kind: AssetKind,
  copies: PlannedCopy[],
  globalRoot = `${homedir()}/.claude`,
): void {
  const globalIds = new Set(readAssetEntries(`${globalRoot}/${kind}`, kind).map((e) => e.id));
  for (const copy of copies) {
    if (globalIds.has(copy.declaredId)) {
      console.error(
        `[workspaces] ${kind} ${copy.declaredId} from ${copy.prefix} shadows the one in ~/.claude`,
      );
    }
  }
}

/**
 * (Re)copies every repo's skills and agents into `<rootPath>/.claude` and
 * answers with what now lives there, keyed by kind. Idempotent: the previous
 * run's copies are removed first, so a repo dropped from the workspace takes its
 * skills with it. Best-effort — a failure is logged, never fatal to
 * provisioning.
 */
export function syncClaudeAssets(rootPath: string, repoWorktreePaths: string[] = []): CopiedAssets {
  const written = emptyManifest();
  const claudeDir = `${rootPath}/.claude`;
  const manifestFile = `${claudeDir}/${MANIFEST_FILE}`;
  try {
    const previous = readManifest(manifestFile);
    mkdirSync(claudeDir, { recursive: true });

    for (const kind of KINDS) {
      const destDir = `${claudeDir}/${kind}`;
      for (const name of previous[kind]) {
        try {
          rmSync(`${destDir}/${name}`, { recursive: true, force: true });
        } catch (e) {
          // Keep it in the manifest so the next run tries again. Dropped, it
          // would read back as one of the user's own and outlive its repo.
          console.error(`[workspaces] could not remove stale ${kind} entry ${name}:`, e);
          written[kind].push(name);
        }
      }

      const repos: RepoAssets[] = [];
      for (const worktree of repoWorktreePaths) {
        const sourceDir = `${worktree}/.claude/${kind}`;
        const entries = readAssetEntries(sourceDir, kind);
        if (entries.length > 0) repos.push({ prefix: prefixFor(worktree), sourceDir, entries });
      }
      if (repos.length === 0) continue;

      // Whatever survived the removal above is the user's own; it keeps its name.
      const { copies, skipped } = planAssetCopies(repos, readAssetEntries(destDir, kind));
      mkdirSync(destDir, { recursive: true });
      for (const copy of copies) {
        const dest = `${destDir}/${copy.name}`;
        cpSync(`${copy.sourceDir}/${copy.entry}`, dest, { recursive: true, dereference: false });
        if (copy.declaredId !== copy.id) alignFrontmatterName(dest, kind, copy.declaredId);
        written[kind].push(copy.name);
      }
      warnOnShadowedGlobals(kind, copies);
      for (const copy of skipped) {
        console.error(
          `[workspaces] skipped ${kind} entry ${copy.entry} from ${copy.prefix}: ${copy.name} is taken`,
        );
      }
    }
  } catch (e) {
    console.error("[workspaces] failed to copy repo skills/agents:", e);
  } finally {
    // Written even when a copy threw part-way: an unrecorded copy is never
    // cleaned up, and the next run reads it back as one of the user's own.
    try {
      writeFileSync(manifestFile, `${JSON.stringify(written, null, 2)}\n`);
    } catch (e) {
      console.error(`[workspaces] failed to record copied skills/agents in ${manifestFile}:`, e);
    }
  }
  return written;
}
