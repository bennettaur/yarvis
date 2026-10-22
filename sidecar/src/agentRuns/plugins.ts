import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import reviewManifest from "../../claude-plugins/yarvis-review/.claude-plugin/plugin.json";
import reviewReadme from "../../claude-plugins/yarvis-review/README.md" with { type: "text" };

/**
 * The Claude Code plugins Yarvis ships to its headless runs.
 *
 * Each plugin's source is a folder under `sidecar/claude-plugins/`, laid out the
 * way Claude Code expects, so it can be reviewed in git and loaded by hand with
 * `claude --plugin-dir`. Its files are imported as text, which embeds them in the
 * compiled sidecar — a release build has no source tree to point Claude Code
 * at — and `materializePlugin` writes them back out under `~/.yarvis` for a run.
 *
 * A file reaches a run only by being listed here: adding an agent or a skill is
 * its file in the plugin folder plus an import and an entry in that plugin's map.
 * Manifests are imported as JSON rather than text because TypeScript types a
 * `.json` import as its parsed shape whatever the import attribute says.
 */
const PLUGINS = {
  "yarvis-review": {
    ".claude-plugin/plugin.json": `${JSON.stringify(reviewManifest, null, 2)}\n`,
    "README.md": reviewReadme,
  },
} satisfies Record<string, Record<string, string>>;

export type PluginName = keyof typeof PLUGINS;

/** `~/.yarvis/claude-plugins`, overridable so tests write somewhere else. */
export function pluginsRoot(): string {
  return process.env.YARVIS_CLAUDE_PLUGINS_DIR ?? join(homedir(), ".yarvis", "claude-plugins");
}

/** Records which content a materialised copy holds, so an unchanged one is left alone. */
const HASH_FILE = ".yarvis-content-hash";

/** A digest of a plugin's files, paths included, so a rename counts as a change. */
export function pluginHash(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files[path] ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Refuses a listed path that would land outside the plugin's folder. */
function checkedRelativePath(path: string): string {
  const normalized = normalize(path);
  if (isAbsolute(normalized) || normalized.split(sep).includes("..")) {
    throw new Error(`plugin file path escapes its folder: ${path}`);
  }
  return normalized;
}

function readHash(dir: string): string | null {
  try {
    return readFileSync(join(dir, HASH_FILE), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Writes a plugin's files to `<root>/<name>` unless that copy already holds the
 * same content, and returns the directory to hand to `--plugin-dir`.
 *
 * A changed plugin is written beside the live copy and swapped in by rename, so
 * a run starting meanwhile sees the old plugin or the new one, never half of
 * each. Another instance sharing `~/.yarvis` may be doing the same thing at the
 * same moment; whichever rename lands second finds the first one's copy, which
 * is fine as long as it holds the content we wanted.
 */
export function materializePlugin(
  name: PluginName,
  root: string = pluginsRoot(),
  files: Record<string, string> = PLUGINS[name],
): string {
  const target = join(root, name);
  const hash = pluginHash(files);
  if (readHash(target) === hash) return target;

  mkdirSync(root, { recursive: true });
  const staging = join(root, `.${name}.staging-${randomUUID()}`);
  try {
    for (const [path, content] of Object.entries(files)) {
      const destination = join(staging, checkedRelativePath(path));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    writeFileSync(join(staging, HASH_FILE), `${hash}\n`);

    // Moved aside rather than deleted first, so the window with no plugin at the
    // target path is a rename long rather than a recursive delete long.
    const retired = join(root, `.${name}.retired-${randomUUID()}`);
    if (existsSync(target)) renameSync(target, retired);
    try {
      renameSync(staging, target);
    } catch (e) {
      if (readHash(target) !== hash) throw e;
    }
    rmSync(retired, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}
