import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readSection } from "../settings/store.ts";

/**
 * What every headless Claude Code launch shares, whether it is a scheduled job
 * (`jobs/runners.ts`) or a streamed agent run (`agentRuns/`): which program to
 * start, where it may start, and the environment it is given.
 */

/** Where the headless Claude Code binary is looked up when nothing is configured. */
const DEFAULT_CLAUDE_COMMAND = "claude";

/**
 * The base command a headless run launches. The Rust core stores the same
 * value for the PTY sessions it starts (`agentCommand` in
 * `~/.yarvis/settings.json`), so a user who pointed the app at a specific build
 * gets that build here too.
 *
 * Only the program is taken, not the whole line: the stored setting is a shell
 * command line with flags for an interactive session, and those flags do not
 * belong on a headless run.
 */
export async function claudeProgram(): Promise<string> {
  const configured = await readSection<string>("agentCommand").catch(() => null);
  return programOf(configured) ?? DEFAULT_CLAUDE_COMMAND;
}

/** The program part of a stored command line, or null when it has none. */
export function programOf(command: string | null | undefined): string | null {
  const first = (command ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  // A setting is hand-editable, and this value becomes argv[0] of a child
  // process: anything with a control character in it is not a program name.
  if (!first) return null;
  for (const char of first) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return first;
}

/**
 * Rejects a working directory that isn't an existing absolute directory path.
 *
 * The value decides where an agent with write access runs. A relative path
 * would resolve against the sidecar's own cwd, which is not a place the user
 * chose.
 */
export function validateWorkingDir(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) throw new Error("a working directory is required");
  if (!isAbsolute(trimmed)) throw new Error("the working directory must be an absolute path");
  if (trimmed.includes("\0")) throw new Error("the working directory is not a valid path");
  if (!existsSync(trimmed) || !statSync(trimmed).isDirectory()) {
    throw new Error(`no such directory: ${trimmed}`);
  }
  return trimmed;
}

/**
 * The environment a headless run is given.
 *
 * Deliberately built rather than inherited. The sidecar's own environment holds
 * every provider key, the database URL, and `YARVIS_SIDECAR_TOKEN` — the bearer
 * for the loopback API, which includes the route that creates scheduled jobs. A
 * headless run that followed an instruction planted in the repository it was
 * pointed at could otherwise use that token to write itself a new job with
 * whatever permissions it liked, so the token must not be in reach. Claude Code
 * authenticates from its own configuration under `HOME`.
 */
export function claudeChildEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "TZ",
    "TMPDIR",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
