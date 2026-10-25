import { isAbsolute, relative } from "node:path";
import { redactSecrets } from "../llm/errors.ts";
import type { AgentRunEvent } from "./events.ts";
import { estimateCostUsd, type TokenUsage } from "./pricing.ts";

/**
 * Reads `claude -p --output-format stream-json --verbose`, one JSON object per
 * line, into the events a run streams to the UI.
 *
 * The format is Claude Code's, not ours, and it grows fields with every
 * release, so this reads only what it needs and skips what it doesn't know:
 * an unknown line type or a malformed line is dropped rather than failing the
 * run. The lines it relies on:
 *
 * - `system`/`init` — the session starting (model, plugins loaded).
 * - `system`/`api_retry` — the API failing and being retried.
 * - `system`/`task_started`, `task_notification`, `task_updated` — a
 *   delegation's lifecycle, which is the only place a backgrounded one ends.
 * - `assistant` — a model message: `text` and `tool_use` blocks, and its token
 *   usage. A message from inside a delegation carries the delegating
 *   `tool_use` id as `parent_tool_use_id`.
 * - `user` — tool results going back to the model, which is where a
 *   foreground delegation's end shows up.
 * - `result` — the run's end: answer, `structured_output` (with
 *   `--json-schema`), cost, duration, session id, `is_error`, `subtype`.
 *
 * Everything that reaches an event is model- or tool-composed text that is kept
 * and displayed, so it is redacted for credential shapes and capped here.
 */

/** Longest text event kept; a run's answer belongs in its structured output. */
const MAX_TEXT_CHARS = 8_000;

/** Longest tool summary: one line in a progress list. */
const MAX_SUMMARY_CHARS = 160;

/** Longest path kept whole; past this it is no path a file tool could open. */
const MAX_PATH_CHARS = 4096;

/** Most Read calls kept for a run; far past what any run makes. */
const MAX_FILE_READS = 20_000;

/** The tools that take one file's path. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * One Read call, as the run made it: the path as given, the 1-based line it
 * started at and how many lines it asked for (null for the tool's defaults),
 * and whether the tool answered with an error.
 */
export interface FileRead {
  path: string;
  offset: number | null;
  limit: number | null;
  failed: boolean;
}

/** The tools Claude Code delegates through; it has used both names. */
export const DELEGATION_TOOLS = ["Agent", "Task"] as const;
const DELEGATION_TOOL_NAMES = new Set<string>(DELEGATION_TOOLS);

/** How `--json-schema` hands back its answer; the `result` line carries it too. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/** Task statuses that mean a delegation is over. */
const TASK_ENDED = new Set(["completed", "failed", "killed", "cancelled", "stopped", "error"]);

/** The `result` line, before the runner validates its output. */
export interface ClaudeStreamResult {
  isError: boolean;
  /** "success", or why it stopped ("error_max_turns", "error_during_execution", …). */
  subtype: string | null;
  text: string;
  structuredOutput: unknown;
  costUsd: number | null;
  durationMs: number | null;
  sessionId: string | null;
}

export interface ParsedLine {
  events: AgentRunEvent[];
  result?: ClaudeStreamResult;
}

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

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string, max: number): string {
  return clip(redactSecrets(text.replace(/\s+/g, " ").trim()), max);
}

/**
 * A short, human description of what a tool call does: the path it reads, the
 * command it runs. Paths inside the run's directory are shown relative to it.
 */
export function summarizeToolInput(name: string, input: unknown, cwd: string): string {
  if (!isObject(input)) return "";
  const path = (value: unknown): string | null => {
    const raw = asString(value);
    if (!raw) return null;
    if (!isAbsolute(raw)) return raw;
    const rel = relative(cwd, raw);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : raw;
  };
  let summary: string | null = null;
  switch (name) {
    case "Bash":
      summary = asString(input.command);
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      summary = path(input.file_path) ?? path(input.notebook_path);
      break;
    case "Grep":
    case "Glob": {
      const pattern = asString(input.pattern);
      const where = path(input.path);
      summary = pattern && where ? `${pattern} in ${where}` : pattern;
      break;
    }
    case "WebFetch":
      summary = asString(input.url);
      break;
    case "WebSearch":
      summary = asString(input.query);
      break;
    case "Skill":
      summary = asString(input.skill) ?? asString(input.command);
      break;
  }
  if (summary === null) {
    // An unknown tool (an MCP tool, one added in a later release): its first
    // string argument is usually the one that says what it is doing.
    summary =
      Object.values(input)
        .map((value) => asString(value))
        .find((value) => value !== null && value.trim().length > 0) ?? "";
  }
  return oneLine(summary, MAX_SUMMARY_CHARS);
}

interface OpenDelegation {
  name: string;
  description: string;
  /** A backgrounded delegation's tool result only says it started. */
  background: boolean;
}

/**
 * Holds what spans lines — which delegations are open, what has been spent —
 * and turns each line into events.
 */
export class StreamJsonParser {
  private readonly openDelegations = new Map<string, OpenDelegation>();
  /** Task ids, which the lifecycle lines use, to the delegating `tool_use` id. */
  private readonly taskToolUse = new Map<string, string>();
  /** Estimated cost per API message. Each content block repeats its message's usage. */
  private readonly messageCosts = new Map<string, number>();
  /**
   * Every Read call, by `tool_use` id, kept apart from the events: a run's
   * event history is capped, and what a run read must be whole to say which
   * files it never opened.
   */
  private readonly reads = new Map<string, FileRead>();

  constructor(private readonly cwd: string) {}

  /** The run's Read calls so far, in the order it made them, main agent and subagents alike. */
  get fileReads(): FileRead[] {
    return [...this.reads.values()];
  }

  /** What the run has spent so far, from the usage on its messages. */
  get estimatedCostUsd(): number {
    let total = 0;
    for (const cost of this.messageCosts.values()) total += cost;
    return total;
  }

  parseLine(line: string): ParsedLine {
    const trimmed = line.trim();
    if (!trimmed) return { events: [] };
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return { events: [] };
    }
    if (!isObject(message)) return { events: [] };
    switch (message.type) {
      case "system":
        return { events: this.parseSystem(message) };
      case "assistant":
        return { events: this.parseAssistant(message) };
      case "user":
        return { events: this.parseUser(message) };
      case "result":
        return { events: [], result: this.parseResult(message) };
      default:
        return { events: [] };
    }
  }

  /**
   * Ends every delegation still open when the run stops. A run that ends
   * mid-delegation (cancelled, timed out, killed) never says the subagent
   * stopped, and a view would show it running forever.
   */
  closeOpenDelegations(): AgentRunEvent[] {
    const events: AgentRunEvent[] = [];
    for (const id of [...this.openDelegations.keys()]) {
      const stop = this.stopDelegation(id, true);
      if (stop) events.push(stop);
    }
    return events;
  }

  private stopDelegation(id: string, failed: boolean): AgentRunEvent | null {
    const delegation = this.openDelegations.get(id);
    if (!delegation) return null;
    this.openDelegations.delete(id);
    const { background: _background, ...shown } = delegation;
    return { type: "subagent", phase: "stop", id, ...shown, failed };
  }

  private parseSystem(message: Json): AgentRunEvent[] {
    switch (message.subtype) {
      case "init": {
        const model = asString(message.model);
        const plugins = Array.isArray(message.plugins)
          ? message.plugins
              .map((plugin) => (isObject(plugin) ? asString(plugin.name) : asString(plugin)))
              .filter((name): name is string => name !== null)
          : [];
        const parts = ["Claude Code started"];
        if (model) parts.push(`with ${model}`);
        if (plugins.length > 0) parts.push(`(plugins: ${plugins.join(", ")})`);
        return [{ type: "status", message: oneLine(parts.join(" "), MAX_SUMMARY_CHARS) }];
      }
      case "api_retry": {
        const attempt = asNumber(message.attempt);
        const max = asNumber(message.max_retries);
        const progress = attempt !== null && max !== null ? ` (attempt ${attempt} of ${max})` : "";
        return [{ type: "status", message: `The API request failed; retrying${progress}` }];
      }
      case "task_started": {
        const taskId = asString(message.task_id);
        const toolUseId = asString(message.tool_use_id);
        if (taskId && toolUseId) this.taskToolUse.set(taskId, toolUseId);
        return [];
      }
      case "task_notification": {
        const toolUseId =
          asString(message.tool_use_id) ?? this.taskToolUse.get(asString(message.task_id) ?? "");
        const status = asString(message.status);
        if (!toolUseId || !status || !TASK_ENDED.has(status)) return [];
        const stop = this.stopDelegation(toolUseId, status !== "completed");
        return stop ? [stop] : [];
      }
      case "task_updated": {
        const toolUseId = this.taskToolUse.get(asString(message.task_id) ?? "");
        const status = isObject(message.patch) ? asString(message.patch.status) : null;
        if (!toolUseId || !status || !TASK_ENDED.has(status)) return [];
        const stop = this.stopDelegation(toolUseId, status !== "completed");
        return stop ? [stop] : [];
      }
      default:
        return [];
    }
  }

  private parseAssistant(message: Json): AgentRunEvent[] {
    const subagentId = asString(message.parent_tool_use_id);
    const body = isObject(message.message) ? message.message : null;
    if (!body) return [];
    const messageId = asString(body.id);
    if (messageId && isObject(body.usage)) {
      this.messageCosts.set(
        messageId,
        estimateCostUsd(asString(body.model), body.usage as TokenUsage),
      );
    }
    const content = body.content;
    if (!Array.isArray(content)) return [];
    const events: AgentRunEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text") {
        const text = asString(block.text)?.trim();
        if (text) {
          events.push({
            type: "text",
            text: clip(redactSecrets(text), MAX_TEXT_CHARS),
            subagentId,
          });
        }
      } else if (block.type === "tool_use") {
        const id = asString(block.id);
        const name = asString(block.name);
        if (!id || !name || name === STRUCTURED_OUTPUT_TOOL) continue;
        if (DELEGATION_TOOL_NAMES.has(name)) {
          const input = isObject(block.input) ? block.input : {};
          const delegation = {
            name: oneLine(asString(input.subagent_type) ?? "general-purpose", MAX_SUMMARY_CHARS),
            description: oneLine(asString(input.description) ?? "", MAX_SUMMARY_CHARS),
          };
          this.openDelegations.set(id, {
            ...delegation,
            background: input.run_in_background === true,
          });
          events.push({ type: "subagent", phase: "start", id, ...delegation });
        } else {
          const input = isObject(block.input) ? block.input : {};
          const rawPath = FILE_TOOLS.has(name)
            ? (asString(input.file_path) ?? asString(input.notebook_path))
            : null;
          const path = rawPath && rawPath.length <= MAX_PATH_CHARS ? rawPath : null;
          if (name === "Read" && path && this.reads.size < MAX_FILE_READS) {
            this.reads.set(id, {
              path,
              offset: asNumber(input.offset),
              limit: asNumber(input.limit),
              failed: false,
            });
          }
          events.push({
            type: "tool",
            id,
            name,
            summary: summarizeToolInput(name, block.input, this.cwd),
            subagentId,
            ...(path ? { path: redactSecrets(path) } : {}),
          });
        }
      }
    }
    return events;
  }

  private parseUser(message: Json): AgentRunEvent[] {
    const content = isObject(message.message) ? message.message.content : null;
    if (!Array.isArray(content)) return [];
    const events: AgentRunEvent[] = [];
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      const id = asString(block.tool_use_id);
      if (!id) continue;
      const read = this.reads.get(id);
      if (read && block.is_error === true) read.failed = true;
      if (this.openDelegations.get(id)?.background !== false) continue;
      const stop = this.stopDelegation(id, block.is_error === true);
      if (stop) events.push(stop);
    }
    return events;
  }

  private parseResult(message: Json): ClaudeStreamResult {
    return {
      isError: message.is_error === true,
      subtype: asString(message.subtype),
      text: clip(redactSecrets(asString(message.result) ?? ""), MAX_TEXT_CHARS),
      structuredOutput: message.structured_output ?? null,
      costUsd: asNumber(message.total_cost_usd),
      durationMs: asNumber(message.duration_ms),
      sessionId: asString(message.session_id),
    };
  }
}
