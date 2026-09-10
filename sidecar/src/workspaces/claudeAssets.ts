import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

export interface RepoAssets {
  /** The repo's worktree directory name, prepended to disambiguate a clash. */
  prefix: string;
  /** Absolute path of the repo's `.claude/<kind>` directory. */
  sourceDir: string;
  /** Entry names inside `sourceDir`: skill directories, or agent `.md` files. */
  entries: string[];
}

export interface PlannedCopy extends Omit<RepoAssets, "entries"> {
  entry: string;
  /** Name the entry gets in the workspace root — `entry`, or a prefixed form. */
  name: string;
}

/**
 * Decides what each repo's entries are called once they all live in one
 * directory. A name offered by more than one repo, or already claimed by an
 * entry we don't manage, is prefixed with the repo's directory name — for *every*
 * repo offering it, not just the losers, so the outcome doesn't depend on the
 * order the repos arrive in and a name stays stable across provisions. An entry
 * whose prefixed name is taken too is reported as skipped rather than silently
 * overwriting the copy that got there first.
 */
export function planAssetCopies(
  repos: RepoAssets[],
  taken: ReadonlySet<string> = new Set(),
): { copies: PlannedCopy[]; skipped: PlannedCopy[] } {
  const offerCounts = new Map<string, number>();
  for (const repo of repos) {
    for (const entry of repo.entries) offerCounts.set(entry, (offerCounts.get(entry) ?? 0) + 1);
  }

  const claimed = new Set(taken);
  const copies: PlannedCopy[] = [];
  const skipped: PlannedCopy[] = [];

  for (const { prefix, sourceDir, entries } of repos) {
    for (const entry of entries) {
      const contested = (offerCounts.get(entry) ?? 0) > 1 || taken.has(entry);
      const name = contested ? `${prefix}-${entry}` : entry;
      const planned: PlannedCopy = { prefix, sourceDir, entry, name };
      if (claimed.has(name)) {
        skipped.push(planned);
        continue;
      }
      claimed.add(name);
      copies.push(planned);
    }
  }

  return { copies, skipped };
}

/** Entries of `dir`, or none when it is missing or unreadable. */
function readEntries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

type Manifest = Record<AssetKind, string[]>;

function emptyManifest(): Manifest {
  return { skills: [], agents: [] };
}

/**
 * Reads the previous run's manifest. Names containing a path separator are
 * dropped: they can only come from a hand-edited file, and every name here is
 * about to be handed to `rm -r`.
 */
function readManifest(file: string): Manifest {
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
      (name): name is string =>
        typeof name === "string" && name.length > 0 && !name.includes("/") && !name.includes("\\"),
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
function alignFrontmatterName(path: string, kind: AssetKind, name: string): void {
  const file = kind === "skills" ? `${path}/SKILL.md` : path;
  const declared = kind === "skills" ? name : name.replace(/\.md$/, "");
  try {
    if (!existsSync(file)) return;
    const content = readFileSync(file, "utf8");
    const [frontmatter, fields = "", closer = ""] =
      content.match(/^---\r?\n([\s\S]*?)(\r?\n---)/) ?? [];
    if (frontmatter === undefined) return;
    const renamed = fields.replace(/^name:.*$/m, `name: ${declared}`);
    if (renamed === fields) return;
    writeFileSync(file, `---\n${renamed}${closer}${content.slice(frontmatter.length)}`);
  } catch (e) {
    console.error(`[workspaces] could not rename ${kind} entry in ${file}:`, e);
  }
}

/**
 * (Re)copies every repo's skills and agents into `<rootPath>/.claude` and
 * answers with what now lives there, keyed by kind. Idempotent: the previous
 * run's copies are removed first, so a repo dropped from the workspace takes its
 * skills with it. Best-effort — a failure is logged, never fatal to
 * provisioning.
 */
export function syncClaudeAssets(rootPath: string, repoWorktreePaths: string[] = []): Manifest {
  const written = emptyManifest();
  try {
    const claudeDir = `${rootPath}/.claude`;
    const manifestFile = `${claudeDir}/${MANIFEST_FILE}`;
    const previous = readManifest(manifestFile);
    mkdirSync(claudeDir, { recursive: true });

    for (const kind of KINDS) {
      const destDir = `${claudeDir}/${kind}`;
      for (const name of previous[kind]) {
        rmSync(`${destDir}/${name}`, { recursive: true, force: true });
      }

      const repos: RepoAssets[] = [];
      for (const worktree of repoWorktreePaths) {
        const sourceDir = `${worktree}/.claude/${kind}`;
        const entries = readEntries(sourceDir);
        if (entries.length > 0) repos.push({ prefix: basename(worktree), sourceDir, entries });
      }
      if (repos.length === 0) continue;

      // Whatever survived the removal above is the user's own; it keeps its name.
      const { copies, skipped } = planAssetCopies(repos, new Set(readEntries(destDir)));
      mkdirSync(destDir, { recursive: true });
      for (const copy of copies) {
        const dest = `${destDir}/${copy.name}`;
        cpSync(`${copy.sourceDir}/${copy.entry}`, dest, { recursive: true });
        if (copy.name !== copy.entry) alignFrontmatterName(dest, kind, copy.name);
        written[kind].push(copy.name);
      }
      for (const copy of skipped) {
        console.error(
          `[workspaces] skipped ${kind} entry ${copy.entry} from ${copy.prefix}: ${copy.name} is taken`,
        );
      }
    }

    writeFileSync(manifestFile, `${JSON.stringify(written, null, 2)}\n`);
  } catch (e) {
    console.error("[workspaces] failed to copy repo skills/agents:", e);
  }
  return written;
}
