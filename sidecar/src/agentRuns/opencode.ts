import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { redactSecrets } from "../llm/errors.ts";
import type { AgentRunEvent } from "./events.ts";
import type { ClaudeStreamResult, FileRead, ParsedLine } from "./streamJson.ts";

/**
 * Runs a part of a fan-out run on OpenCode (v2) instead of Claude Code.
 *
 * The same rules hold as for a Claude Code run, met OpenCode's way:
 *
 * - No user or checkout config is read. Each process gets empty config, data,
 *   state and cache folders of its own (`XDG_*_HOME`), and it starts in a
 *   folder of its own rather than in the checkout, since OpenCode loads
 *   `opencode.json`, `.opencode/` plugins and MCP servers from every folder
 *   between its working directory and `/`. A checkout's plugin runs code the
 *   moment OpenCode starts.
 * - `--standalone`, since without it `opencode run` hands the session to a
 *   background service that the user's own sessions share, with its own
 *   folders, environment and sandbox.
 * - The run's one agent denies every tool but read, grep and glob, and allows
 *   reading outside its folder only in the checkout and the context folder.
 *   OpenCode doesn't offer a denied tool to the model at all.
 * - `sandbox-exec` wraps the process as a second layer: no writes outside the
 *   process's own folder, and no reads of the home folder's credentials or of
 *   the user's own OpenCode folders, whose `auth.json` holds provider logins.
 *   Provider keys come only from the harness's secret environment.
 * - OpenCode has no structured-output tool, so the agent is told the answer's
 *   JSON schema and its last message is parsed as JSON. The fan-out checks it
 *   against the schema and asks once more when it doesn't fit.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** What a Claude Code tool list grants, in OpenCode's permission actions. */
const OPENCODE_ACTIONS: Record<string, string> = { Read: "read", Grep: "grep", Glob: "glob" };

/**
 * The OpenCode permission actions for `allowedTools`. Anything else is refused,
 * so a caller can't believe it granted a tool this backend never offers.
 */
export function openCodeActions(allowedTools: readonly string[]): string[] {
  return allowedTools.map((tool) => {
    const action = OPENCODE_ACTIONS[tool];
    if (!action) throw new Error(`an OpenCode run can't be given ${tool}`);
    return action;
  });
}

/** The process's folders, all inside one private temp folder that goes when it ends. */
export interface OpenCodeDirs {
  root: string;
  /** Its working directory: holds only the run's `opencode.json`. */
  project: string;
  config: string;
  data: string;
  state: string;
  cache: string;
  tmp: string;
}

export function makeOpenCodeDirs(base: string = tmpdir()): OpenCodeDirs {
  // mkdtemp creates it 0700. Realpath, since the sandbox matches resolved paths.
  const root = realpathSync(mkdtempSync(join(base, "yarvis-opencode-")));
  const dirs = {
    root,
    project: join(root, "project"),
    config: join(root, "config"),
    data: join(root, "data"),
    state: join(root, "state"),
    cache: join(root, "cache"),
    tmp: join(root, "tmp"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}

export function removeOpenCodeDirs(dirs: OpenCodeDirs): void {
  rmSync(dirs.root, { recursive: true, force: true });
}

/** An OpenCode permission rule; the last one that matches wins. */
interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

/**
 * The `opencode.json` for one process: a single agent, with `system` as its
 * prompt, that may use `actions` and read inside `readable` and nowhere else
 * outside its own folder.
 */
export function openCodeConfig(options: {
  agentId: string;
  system: string;
  actions: readonly string[];
  readable: readonly string[];
}): Record<string, unknown> {
  const permissions: PermissionRule[] = [
    { action: "*", resource: "*", effect: "deny" },
    ...options.actions.map(
      (action): PermissionRule => ({ action, resource: "*", effect: "allow" }),
    ),
    ...options.readable.map(
      (dir): PermissionRule => ({
        action: "external_directory",
        resource: `${dir}/*`,
        effect: "allow",
      }),
    ),
  ];
  return {
    $schema: "https://opencode.ai/config.json",
    agents: {
      [options.agentId]: { mode: "primary", system: options.system, permissions },
    },
  };
}

/** Writes the config into the process's working directory, where OpenCode looks first. */
export function writeOpenCodeConfig(dirs: OpenCodeDirs, config: Record<string, unknown>): void {
  writeFileSync(join(dirs.project, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Added to the agent's prompt. The agents were written for Claude Code, whose
 * run starts in the checkout and answers through a tool.
 */
export function openCodeInstructions(checkout: string, answerSchema: string): string {
  return [
    "## Where things are",
    "",
    `The PR checkout is at ${checkout}. It is not your working directory, so give`,
    "its full path, or a path inside it, to Read, Grep and Glob. Wherever these",
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

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The sandbox for one process. Reads are allowed but for `secretPaths` and the
 * user's own OpenCode folders; writes only in its own folder. The network is
 * open, since the model is reached over it, and OpenCode's own permissions
 * keep the model from a tool that could use it.
 */
export function openCodeSandboxProfile(options: {
  root: string;
  /** Under the home folder, e.g. `.ssh`. */
  secretPaths: readonly string[];
  home?: string;
}): string {
  const home = realpathOr(options.home ?? homedir());
  const sub = (path: string) => `(subpath ${sbString(path)})`;
  const denied = [
    ...options.secretPaths,
    ".config/opencode",
    ".local/share/opencode",
    ".local/state/opencode",
    ".cache/opencode",
  ].map((path) => sub(join(home, path)));
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${denied.join(" ")})`,
    "(deny file-write*)",
    `(allow file-write* ${sub(realpathOr(options.root))} ${[
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/dtracehelper")',
      '(regex #"^/dev/fd/")',
    ].join(" ")})`,
    // A hard link inside the folder to a file outside it would make that file writable.
    "(deny file-link)",
  ].join("\n");
}

/**
 * Over the harness's environment, which comes first: every folder OpenCode
 * reads or writes points into the process's own, and the model catalog is a
 * file rather than a download that races the run's first step.
 */
export function openCodeEnv(dirs: OpenCodeDirs, catalog: string | null): Record<string, string> {
  return {
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    TMPDIR: dirs.tmp,
    ...(catalog && { OPENCODE_MODELS_PATH: catalog, OPENCODE_DISABLE_MODELS_FETCH: "true" }),
  };
}

/**
 * The program and argv: OpenCode under `sandbox-exec`. The message is an
 * argument, since `opencode run` takes no prompt on stdin; it is the task
 * Yarvis wrote, not PR text, which reaches the run only as files.
 */
export function openCodeCommand(options: {
  program: string;
  profile: string;
  agentId: string;
  model: string;
  prompt: string;
}): { program: string; args: string[] } {
  if (options.prompt.startsWith("-")) throw new Error("an OpenCode run's task can't start with -");
  return {
    program: SANDBOX_EXEC,
    args: [
      "-p",
      options.profile,
      options.program,
      "run",
      "--standalone",
      "--format",
      "json",
      "--agent",
      options.agentId,
      "--model",
      options.model,
      options.prompt,
    ],
  };
}

/**
 * The JSON object in a model's last message: the whole message, or the part
 * between its first `{` and last `}` when it wrapped the object in a fence or
 * a sentence despite being told not to. Null when there is none.
 */
export function jsonAnswer(text: string): unknown {
  const attempts = [text.trim()];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) attempts.push(text.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      const value: unknown = JSON.parse(attempt);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Try the next.
    }
  }
  return null;
}

/** Longest text event kept, as for a Claude Code run. */
const MAX_TEXT_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 160;
const MAX_PATH_CHARS = 4096;
const MAX_FILE_READS = 20_000;

/** How OpenCode's read tool says what it showed: "Read file <path>, lines 1-4". */
const READ_RANGE = /, lines (\d+)-(\d+)/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneLine(text: string, max: number): string {
  const line = redactSecrets(text.replace(/\s+/g, " ").trim());
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Reads `opencode run --format json`, one JSON object per line, into the
 * events a run streams, as `StreamJsonParser` does for Claude Code. The lines
 * it relies on (checked against 2.3.2): `tool_use` with the finished call
 * (`part.tool`, `part.state.status`, `.input`, `.output`), `text`,
 * `step_finish` with the step's `cost` and `reason` ("stop" on the last), and
 * `error`. Anything else is skipped.
 *
 * OpenCode names its tools in lower case. They are shown under Claude Code's
 * names, so a run reads the same whichever harness ran it, and its reads count
 * towards coverage the same way.
 */
export class OpenCodeEventParser {
  private readonly reads: FileRead[] = [];
  private cost = 0;
  private lastText = "";
  private readonly startedAt = Date.now();

  constructor(private readonly checkout: string) {}

  get fileReads(): FileRead[] {
    return [...this.reads];
  }

  /** An OpenCode part has no subagents. */
  get subagents(): ReadonlyMap<string, string> {
    return new Map();
  }

  get estimatedCostUsd(): number {
    return this.cost;
  }

  closeOpenDelegations(): AgentRunEvent[] {
    return [];
  }

  parseLine(line: string): ParsedLine {
    let message: unknown;
    try {
      message = JSON.parse(line.trim());
    } catch {
      return { events: [] };
    }
    if (!isObject(message)) return { events: [] };
    const part = isObject(message.part) ? message.part : {};
    switch (message.type) {
      case "text": {
        const text = asString(part.text)?.trim();
        if (!text) return { events: [] };
        this.lastText = text;
        return {
          events: [
            { type: "text", text: redactSecrets(text).slice(0, MAX_TEXT_CHARS), subagentId: null },
          ],
        };
      }
      case "tool_use":
        return { events: this.parseTool(part) };
      case "step_finish": {
        this.cost += asNumber(part.cost) ?? 0;
        if (part.reason !== "stop") return { events: [] };
        return { events: [], result: this.result(false, this.lastText, message.sessionID) };
      }
      case "error": {
        const error = isObject(message.error) ? message.error : {};
        const text =
          asString(error.message) ?? asString(error.type) ?? "OpenCode reported an error";
        return { events: [], result: this.result(true, text, message.sessionID) };
      }
      default:
        return { events: [] };
    }
  }

  private result(isError: boolean, text: string, sessionId: unknown): ClaudeStreamResult {
    const redacted = redactSecrets(text).slice(0, MAX_TEXT_CHARS);
    return {
      isError,
      subtype: isError ? "error" : "success",
      text: redacted,
      structuredOutput: isError ? null : jsonAnswer(text),
      costUsd: this.cost,
      durationMs: Date.now() - this.startedAt,
      sessionId: asString(sessionId),
    };
  }

  private parseTool(part: Json): AgentRunEvent[] {
    const id = asString(part.id) ?? asString(part.partID);
    const tool = asString(part.tool);
    if (!id || !tool) return [];
    const state = isObject(part.state) ? part.state : {};
    const input = isObject(state.input) ? state.input : {};
    const name = tool === "read" || tool === "grep" || tool === "glob" ? capitalize(tool) : tool;
    if (tool === "read") this.recordRead(input, state);
    return [{ type: "tool", id, name, summary: this.summary(tool, input), subagentId: null }];
  }

  /**
   * Keeps one read, with the lines it showed as OpenCode reported them, since
   * that is what the model saw whatever it asked for. A read whose output
   * doesn't say counts for nothing.
   */
  private recordRead(input: Json, state: Json): void {
    if (this.reads.length >= MAX_FILE_READS) return;
    const path = asString(input.path) ?? asString(input.filePath) ?? asString(input.file_path);
    if (!path || path.length > MAX_PATH_CHARS) return;
    const failed = state.status !== "completed";
    const range = READ_RANGE.exec(asString(state.output) ?? "");
    const first = range ? Number(range[1]) : null;
    const last = range ? Number(range[2]) : null;
    this.reads.push({
      path,
      offset: first,
      limit: first !== null && last !== null ? last - first + 1 : null,
      malformed: !failed && range === null,
      failed,
      subagentId: null,
    });
  }

  private summary(tool: string, input: Json): string {
    const path = (value: unknown): string | null => {
      const raw = asString(value);
      if (!raw || !isAbsolute(raw)) return raw;
      const rel = relative(this.checkout, raw);
      return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : raw;
    };
    const pattern = asString(input.pattern);
    const where = path(input.path);
    const summary =
      tool === "read"
        ? where
        : tool === "grep" || tool === "glob"
          ? pattern && where
            ? `${pattern} in ${where}`
            : pattern
          : (Object.values(input)
              .map(asString)
              .find((v) => v?.trim()) ?? "");
    return oneLine(summary ?? "", MAX_SUMMARY_CHARS);
  }
}

function capitalize(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}
