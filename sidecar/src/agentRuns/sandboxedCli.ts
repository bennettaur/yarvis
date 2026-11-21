import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactSecrets } from "../llm/errors.ts";

/**
 * What the fan-out backends other than Claude Code share (`opencode.ts`,
 * `pi.ts`): the `sandbox-exec` profile each process runs under, the prompt
 * text that says where the checkout is and how to answer, and reading that
 * answer back out of the last message. Neither CLI has a structured-output
 * tool, so the answer is the last message, parsed as JSON.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Added to the agent's prompt. The agents were written for Claude Code, whose
 * run starts in the checkout and answers through a tool. `tools` names the
 * CLI's own file tools, as the model sees them.
 */
export function checkoutInstructions(
  checkout: string,
  answerSchema: string,
  tools: string,
): string {
  return [
    "## Where things are",
    "",
    `The PR checkout is at ${checkout}. It is not your working directory, so give`,
    `its full path, or a path inside it, to ${tools}. Wherever these`,
    "instructions say the working directory, they mean the checkout.",
    "",
    "## Your answer",
    "",
    "End with your answer as your last message: one JSON object matching this JSON",
    "schema, and nothing else, with no prose before or after it and no code fence.",
    "",
    answerSchema,
  ].join("\n");
}

/** A Seatbelt string literal. */
function sbString(value: string): string {
  if (/["\\\0\n]/.test(value)) throw new Error(`unsafe path for the sandbox profile: ${value}`);
  return `"${value}"`;
}

export function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `/a/b/c` → `/`, `/a`, `/a/b`: what a process stats on the way to `/a/b/c`. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    out.push(dir);
    if (dir === dirname(dir)) return out;
  }
}

/**
 * The sandbox for one process. In the real home folder it reads only the
 * `readable` folders and its programs, never `secretPaths`; it writes only in
 * its own folder; and it runs only `programs` and what it put in that folder
 * (the ripgrep OpenCode downloads, say). The network is open, since the model
 * is reached over it; the CLI offers the model no tool that could use it.
 */
export function sandboxProfile(options: {
  root: string;
  /** Folders it may read wherever they are: the checkout, the context folder, a CLI's install. */
  readable: readonly string[];
  /** Executables it may run besides those in `root`: the CLI, ripgrep. */
  programs: readonly string[];
  /** Under the home folder, e.g. `.ssh`. `.claude` and `.agents` are always denied. */
  secretPaths: readonly string[];
  home?: string;
}): string {
  const home = realpathOr(options.home ?? homedir());
  const root = realpathOr(options.root);
  const sub = (path: string) => `(subpath ${sbString(path)})`;
  const lit = (path: string) => `(literal ${sbString(path)})`;
  const readable = [root, ...options.readable.map(realpathOr)];
  // A program is often a link (`/opt/homebrew/bin/opencode`); exec checks both names.
  const programs = [...new Set(options.programs.flatMap((p) => [p, realpathOr(p)]))];
  const secrets = [...options.secretPaths, ".claude", ".agents"].map((p) => sub(join(home, p)));
  // Stat-ing the way down to what it may read has to work, or `realpath` fails.
  const metadata = [...new Set([...readable, ...programs].flatMap((p) => [p, ...ancestors(p)]))];
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${sub(home)})`,
    `(allow file-read* ${[...readable.map(sub), ...programs.map(lit)].join(" ")})`,
    `(deny file-read* ${secrets.join(" ")})`,
    `(allow file-read-metadata ${metadata.map(lit).join(" ")})`,
    "(deny file-write*)",
    `(allow file-write* ${sub(root)} ${[
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/dtracehelper")',
      '(regex #"^/dev/fd/")',
    ].join(" ")})`,
    // A hard link inside the folder to a file outside it would make that file writable.
    "(deny file-link)",
    "(deny process-exec)",
    `(allow process-exec ${[...programs.map(lit), sub(root)].join(" ")})`,
  ].join("\n");
}

/**
 * The JSON object a model's last message holds: the whole message, or the one
 * fenced block it wrapped the object in despite being told not to. Null for
 * anything else, so an object the model only quoted, from a file it read, is
 * never taken for its answer.
 */
export function jsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  try {
    const value: unknown = JSON.parse(fenced?.[1] ?? trimmed);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Longest text event kept, as for a Claude Code run. */
export const MAX_TEXT_CHARS = 8_000;
export const MAX_SUMMARY_CHARS = 160;
export const MAX_PATH_CHARS = 4096;
export const MAX_FILE_READS = 20_000;

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function oneLine(text: string, max: number): string {
  const line = redactSecrets(text.replace(/\s+/g, " ").trim());
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
