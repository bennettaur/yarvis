import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { redactSecrets } from "../llm/errors.ts";
import type { AgentRunEvent } from "./events.ts";
import {
  asNumber,
  asString,
  checkoutInstructions,
  isObject,
  type Json,
  jsonAnswer,
  MAX_FILE_READS,
  MAX_PATH_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TEXT_CHARS,
  oneLine,
  realpathOr,
} from "./sandboxedCli.ts";
import type { ClaudeStreamResult, FileRead, ParsedLine } from "./streamJson.ts";

/**
 * Runs a part of a fan-out run on Pi (`@earendil-works/pi-coding-agent`)
 * instead of Claude Code. What Yarvis relies on is Pi's own CLI, which is the
 * contract a customized build has to keep:
 *
 * - `--mode json`: one JSONL event per line, ending with `agent_settled`.
 * - `--tools read,grep,find,ls` as the only tools offered. Pi has no
 *   permission rules, so nothing else limits what those tools may read. The
 *   `sandbox-exec` profile does: in the home folder, the temp folder and the
 *   shared folders it reads only the checkout, the context folder and Pi's own
 *   package, never a CLI's logins; it writes only in its own folder; and it
 *   runs only Node (or a compiled Pi), ripgrep and fd. System folders such as
 *   `/usr` stay readable, since Node needs them.
 * - No config but the run's: `PI_CODING_AGENT_DIR` points at an empty folder
 *   of its own (the user's `~/.pi/agent` holds extensions, which are code, and
 *   `auth.json`, which holds logins), and `--no-extensions`, `--no-mcp`,
 *   `--no-skills`, `--no-prompt-templates`, `--no-themes`,
 *   `--no-context-files` (no `AGENTS.md` or `CLAUDE.md`) and `--no-approve`
 *   (no project `.pi` folder) load nothing else. It starts in a folder of its
 *   own rather than the checkout too, since Pi reads project config from its
 *   working directory.
 * - `--no-session`, so no transcript is written, and `--offline`, so it
 *   downloads neither a model catalog nor the ripgrep or fd it can't find.
 * - `--system-prompt <file>` replaces Pi's prompt with the plugin agent's.
 * - `--model provider/id[:thinking]`, the thinking level carrying the effort.
 *
 * Provider keys come only from the harness's secret environment. A part that
 * uses a tool it wasn't given fails, whatever it answered.
 */

/** What a Claude Code tool list grants, in Pi's tool names. */
const PI_TOOLS: Record<string, readonly string[]> = {
  Read: ["read"],
  Grep: ["grep"],
  Glob: ["find", "ls"],
};

/** The programs Pi's own tools run, by tool. */
const TOOL_PROGRAMS: Record<string, string> = { grep: "rg", find: "fd" };

/**
 * Pi's tools for `allowedTools`, less any whose program isn't installed
 * (`available` says which are), since `--offline` keeps Pi from downloading
 * it. Anything else is refused, so a caller can't believe it granted a tool
 * this backend never offers.
 */
export function piTools(
  allowedTools: readonly string[],
  available: (program: string) => boolean,
): string[] {
  const tools = allowedTools.flatMap((tool) => {
    const names = PI_TOOLS[tool];
    if (!names) throw new Error(`a Pi run can't be given ${tool}`);
    return names;
  });
  return [...new Set(tools)].filter((tool) => {
    const program = TOOL_PROGRAMS[tool];
    return !program || available(program);
  });
}

/** The process's folders, all inside one private temp folder that goes when it ends. */
export interface PiDirs {
  root: string;
  /** Its `HOME`. */
  home: string;
  /** Its working directory, which stays empty. */
  project: string;
  /** `PI_CODING_AGENT_DIR`. */
  agent: string;
  tmp: string;
  /** The system prompt, passed by path rather than on the command line. */
  systemPrompt: string;
}

export function makePiDirs(base: string = tmpdir()): PiDirs {
  // mkdtemp creates it 0700. Realpath, since the sandbox matches resolved paths.
  const root = realpathSync(mkdtempSync(join(base, "yarvis-pi-")));
  const dirs = {
    root,
    home: join(root, "home"),
    project: join(root, "project"),
    agent: join(root, "agent"),
    tmp: join(root, "tmp"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return { ...dirs, systemPrompt: join(root, "system-prompt.md") };
}

export function removePiDirs(dirs: PiDirs): void {
  rmSync(dirs.root, { recursive: true, force: true });
}

/**
 * Added to the agent's prompt: where the checkout is and how to answer.
 * `tools` are the ones the run was given, so the prompt names no tool a
 * missing program left out.
 */
export function piInstructions(
  checkout: string,
  answerSchema: string,
  tools: readonly string[],
): string {
  const names =
    tools.length > 1 ? `${tools.slice(0, -1).join(", ")} and ${tools.at(-1)}` : (tools[0] ?? "");
  return checkoutInstructions(checkout, answerSchema, names);
}

/**
 * How to start Pi. An npm install's `pi` is a link to a Node script, which
 * is run with the `node` installed beside it (npm puts global bins next to
 * Node's) so no version manager's shim runs under the sandbox. `readable` is
 * the package's folder, which holds its dependencies. Anything else, such as
 * a compiled build, is run as it is. A shell wrapper can't run that way:
 * the profile lets it run neither its shell nor what the wrapper starts.
 */
export interface PiLaunch {
  /** What `sandbox-exec` runs. */
  program: string;
  /** Before Pi's own arguments: the script, when `program` is Node. */
  args: string[];
  /** The executables the profile allows. */
  programs: string[];
  /** Folders the profile lets it read: Pi's package. */
  readable: string[];
}

export function piLaunch(program: string, onPath: (name: string) => string | null): PiLaunch {
  const script = realpathOr(program);
  if (!isNodeScript(script)) return { program, args: [], programs: [program], readable: [] };
  const beside = join(dirname(program), "node");
  const node = existsSync(beside) ? beside : onPath("node");
  if (!node)
    throw new Error(`Pi (${program}) is a Node script, but there's no node beside it or on PATH`);
  const realNode = realpathOr(node);
  // A version manager's shim resolves to the manager itself, which can't run under the sandbox.
  if (basename(realNode) !== "node") {
    throw new Error(
      `Pi's node (${node}) is ${realNode}, not Node itself; install Pi with npm so its node sits beside it`,
    );
  }
  return {
    program: realNode,
    args: [script],
    programs: [realNode],
    readable: [packageRoot(script, realpathOr(homedir()))],
  };
}

/** Whether `path` starts with a `#!` line that runs Node. */
function isNodeScript(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(128);
    const line = head.toString("utf8", 0, readSync(fd, head, 0, head.length, 0)).split("\n", 1)[0];
    return !!line?.startsWith("#!") && /\bnode\b/.test(line);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The package `script` is the `pi` bin of: the nearest folder above it with a
 * `package.json` whose `bin` names it. The profile lets the run read all of
 * it, so a `package.json` that only happens to sit above the script (one in
 * the home folder, say) is refused rather than granted.
 */
function packageRoot(script: string, home: string): string {
  for (let dir = dirname(script); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    if (!binNames(manifest, dir).includes(script)) break;
    if (!relative(dir, home).startsWith("..")) break;
    return dir;
  }
  throw new Error(`Pi's script ${script} isn't the pi bin of an npm package`);
}

/** The scripts a `package.json`'s `bin` names, resolved. */
function binNames(manifest: string, dir: string): string[] {
  try {
    const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: unknown };
    const paths = typeof bin === "string" ? [bin] : isObject(bin) ? Object.values(bin) : [];
    return paths.flatMap((p) => (typeof p === "string" ? [realpathOr(join(dir, p))] : []));
  } catch {
    return [];
  }
}

/** Over the harness's environment: every folder Pi reads or writes points into the process's own. */
export function piEnv(dirs: PiDirs): Record<string, string> {
  return {
    HOME: dirs.home,
    PI_CODING_AGENT_DIR: dirs.agent,
    XDG_CONFIG_HOME: join(dirs.home, ".config"),
    XDG_DATA_HOME: join(dirs.home, ".local", "share"),
    XDG_STATE_HOME: join(dirs.home, ".local", "state"),
    XDG_CACHE_HOME: join(dirs.home, ".cache"),
    TMPDIR: dirs.tmp,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

/**
 * The program and argv: Pi under `sandbox-exec`. The message is the last
 * argument, after `--`; it is the task Yarvis wrote, not PR text, which reaches
 * the run only as files.
 */
export function piCommand(options: {
  /** What applies the profile: `sandbox-exec`, or a test's stand-in. */
  sandboxExec: string;
  launch: PiLaunch;
  profile: string;
  tools: readonly string[];
  systemPromptFile: string;
  model: string;
  prompt: string;
}): { program: string; args: string[] } {
  return {
    program: options.sandboxExec,
    args: [
      "-p",
      options.profile,
      options.launch.program,
      ...options.launch.args,
      "--mode",
      "json",
      "--no-session",
      "--offline",
      "--no-approve",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--tools",
      options.tools.join(","),
      "--system-prompt",
      options.systemPromptFile,
      "--model",
      options.model,
      "--",
      options.prompt,
    ],
  };
}

/** Writes the system prompt where `--system-prompt` reads it. */
export function writePiSystemPrompt(dirs: PiDirs, system: string): void {
  writeFileSync(dirs.systemPrompt, `${system}\n`);
}

/** Pi's tool names, shown under Claude Code's. */
const CLAUDE_TOOL_NAMES: Record<string, string> = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
};

/**
 * Reads `pi --mode json`, one JSON object per line, into the events a run
 * streams, as `StreamJsonParser` does for Claude Code. The lines it relies on:
 * the `session` header (its `id`), `tool_execution_start` (`toolCallId`,
 * `toolName`, `args`), `tool_execution_end` (`result.details`, `isError`),
 * `message_end` with each finished message (an assistant's `content`,
 * `stopReason`, `errorMessage` and `usage.cost.total`), and `agent_settled`,
 * after which Pi does nothing more. Anything else is skipped.
 *
 * The answer is the last assistant message's text, once Pi has settled: a
 * retried turn ends with a later message, and `agent_end` can come before
 * a retry.
 */
export class PiEventParser {
  private readonly reads: FileRead[] = [];
  /** The first tool it used that it wasn't given, which fails the run. */
  private forbidden: string | null = null;
  private cost = 0;
  private sessionId: string | null = null;
  /** The last finished assistant message, which once Pi settles is the answer. */
  private last: { text: string; stopReason: string | null; error: string | null } | null = null;
  /** Each read's arguments, until its result says what it showed. */
  private readonly pendingReads = new Map<string, Json>();
  private readonly startedAt = Date.now();

  /**
   * `checkout` is what tool summaries are shown relative to; `allowedTools`
   * are Pi's names for the tools the run was given.
   */
  constructor(
    private readonly checkout: string,
    private readonly allowedTools: ReadonlySet<string>,
  ) {}

  get fileReads(): FileRead[] {
    return [...this.reads];
  }

  /** A Pi part has no subagents. */
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
    switch (message.type) {
      case "session":
        this.sessionId = asString(message.id);
        return { events: [] };
      case "tool_execution_start":
        return { events: this.toolStarted(message) };
      case "tool_execution_end":
        this.toolEnded(message);
        return { events: [] };
      case "message_end":
        return { events: this.messageEnded(message.message) };
      case "agent_settled":
        return { events: [], result: this.settled(message.aborted === true) };
      default:
        return { events: [] };
    }
  }

  private messageEnded(value: unknown): AgentRunEvent[] {
    if (!isObject(value) || value.role !== "assistant") return [];
    const usage = isObject(value.usage) ? value.usage : {};
    const cost = isObject(usage.cost) ? usage.cost : {};
    this.cost += asNumber(cost.total) ?? 0;
    const content = Array.isArray(value.content) ? value.content : [];
    const text = content
      .filter((block): block is Json => isObject(block) && block.type === "text")
      .map((block) => asString(block.text)?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n");
    this.last = {
      text,
      stopReason: asString(value.stopReason),
      error: asString(value.errorMessage),
    };
    if (!text) return [];
    return [{ type: "text", text: redactSecrets(text).slice(0, MAX_TEXT_CHARS), subagentId: null }];
  }

  private settled(aborted: boolean): ClaudeStreamResult {
    const last = this.last;
    if (aborted) return this.result(true, "Pi stopped the run");
    if (!last) return this.result(true, "Pi settled without answering");
    if (last.stopReason !== "stop") {
      const why = last.error ?? `its last message stopped with ${last.stopReason ?? "no reason"}`;
      return this.result(true, why);
    }
    return this.result(false, last.text);
  }

  private result(isError: boolean, text: string): ClaudeStreamResult {
    if (this.forbidden) {
      isError = true;
      text = `it used a tool it wasn't given (${this.forbidden}), so its answer was discarded`;
    }
    return {
      isError,
      subtype: isError ? "error" : "success",
      text: redactSecrets(text).slice(0, MAX_TEXT_CHARS),
      structuredOutput: isError ? null : jsonAnswer(text),
      costUsd: this.cost,
      durationMs: Date.now() - this.startedAt,
      sessionId: this.sessionId,
    };
  }

  private toolStarted(message: Json): AgentRunEvent[] {
    const id = asString(message.toolCallId);
    const tool = asString(message.toolName);
    if (!id || !tool) return [];
    const args = isObject(message.args) ? message.args : {};
    if (!this.allowedTools.has(tool)) this.forbidden ??= tool;
    if (tool === "read") this.pendingReads.set(id, args);
    const name = CLAUDE_TOOL_NAMES[tool] ?? tool;
    return [{ type: "tool", id, name, summary: this.summary(tool, args), subagentId: null }];
  }

  /**
   * Keeps one read, with the lines it showed: those it asked for, cut short
   * where Pi's result says it truncated them. That comes from the result's
   * `details`, not its text, which is the file's own.
   */
  private toolEnded(message: Json): void {
    const id = asString(message.toolCallId);
    const args = id ? this.pendingReads.get(id) : undefined;
    if (!id || !args) return;
    this.pendingReads.delete(id);
    if (this.reads.length >= MAX_FILE_READS) return;
    const path = asString(args.path);
    if (!path || path.length > MAX_PATH_CHARS) return;
    const result = isObject(message.result) ? message.result : {};
    const details = isObject(result.details) ? result.details : {};
    const truncation = isObject(details.truncation) ? details.truncation : null;
    const offset = asNumber(args.offset);
    const asked = asNumber(args.limit);
    const shown = truncation?.truncated === true ? asNumber(truncation.outputLines) : null;
    this.reads.push({
      path,
      offset,
      limit: shown ?? asked,
      malformed: truncation?.truncated === true && shown === null,
      failed: message.isError === true,
      subagentId: null,
    });
  }

  private summary(tool: string, args: Json): string {
    const raw = asString(args.path);
    let where = raw;
    if (raw && isAbsolute(raw)) {
      const rel = relative(this.checkout, raw);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) where = rel;
    }
    const pattern = asString(args.pattern);
    if (tool === "read" || tool === "ls") return oneLine(where ?? "", MAX_SUMMARY_CHARS);
    if (tool === "grep" || tool === "find") {
      return oneLine(
        pattern && where ? `${pattern} in ${where}` : (pattern ?? ""),
        MAX_SUMMARY_CHARS,
      );
    }
    // Another tool: its first string argument usually says what it is doing.
    const first = Object.values(args)
      .map(asString)
      .find((value) => value?.trim());
    return oneLine(first ?? "", MAX_SUMMARY_CHARS);
  }
}
