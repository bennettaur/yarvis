import { isAbsolute, relative } from "node:path";
import { redactSecrets } from "../llm/errors.ts";
import type { AgentRunEvent } from "./events.ts";

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
 * - `assistant` — a model message: `text` and `tool_use` blocks. A message
 *   from inside a delegation carries the delegating `tool_use` id as
 *   `parent_tool_use_id`.
 * - `user` — tool results going back to the model, which is where a
 *   delegation's end shows up.
 * - `result` — the run's end: answer, `structured_output` (with
 *   `--json-schema`), cost, duration, session id, `is_error`.
 *
 * Everything that reaches an event is model- or tool-composed text that is kept
 * and displayed, so it is redacted for credential shapes and capped here.
 */

/** Longest text event kept; a run's answer belongs in its structured output. */
const MAX_TEXT_CHARS = 8_000;

/** Longest tool summary: one line in a progress list. */
const MAX_SUMMARY_CHARS = 160;

/** The tools Claude Code delegates through; it has used both names. */
const DELEGATION_TOOLS = new Set(["Agent", "Task"]);

/** How `--json-schema` hands back its answer; the `result` line carries it too. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

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

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
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
    const raw = str(value);
    if (!raw) return null;
    if (!isAbsolute(raw)) return raw;
    const rel = relative(cwd, raw);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : raw;
  };
  let summary: string | null = null;
  switch (name) {
    case "Bash":
      summary = str(input.command);
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
      const pattern = str(input.pattern);
      const where = path(input.path);
      summary = pattern && where ? `${pattern} in ${where}` : pattern;
      break;
    }
    case "WebFetch":
      summary = str(input.url);
      break;
    case "WebSearch":
      summary = str(input.query);
      break;
    case "Skill":
      summary = str(input.skill) ?? str(input.command);
      break;
  }
  if (summary === null) {
    // An unknown tool (an MCP tool, one added in a later release): its first
    // string argument is usually the one that says what it is doing.
    summary =
      Object.values(input)
        .map((value) => str(value))
        .find((value) => value !== null && value.trim().length > 0) ?? "";
  }
  return oneLine(summary, MAX_SUMMARY_CHARS);
}

/**
 * Holds what spans lines — which delegations are open, so a tool result can be
 * recognised as one ending — and turns each line into events.
 */
export class StreamJsonParser {
  private readonly openDelegations = new Map<string, { name: string; description: string }>();

  constructor(private readonly cwd: string) {}

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
        return { events: this.system(message) };
      case "assistant":
        return { events: this.assistant(message) };
      case "user":
        return { events: this.user(message) };
      case "result":
        return { events: [], result: this.result(message) };
      default:
        return { events: [] };
    }
  }

  private system(message: Json): AgentRunEvent[] {
    if (message.subtype === "init") {
      const model = str(message.model);
      const plugins = Array.isArray(message.plugins)
        ? message.plugins
            .map((plugin) => (isObject(plugin) ? str(plugin.name) : str(plugin)))
            .filter((name): name is string => name !== null)
        : [];
      const parts = ["Claude Code started"];
      if (model) parts.push(`with ${model}`);
      if (plugins.length > 0) parts.push(`(plugins: ${plugins.join(", ")})`);
      return [{ type: "status", message: oneLine(parts.join(" "), MAX_SUMMARY_CHARS) }];
    }
    if (message.subtype === "api_retry") {
      const attempt = num(message.attempt);
      const max = num(message.max_retries);
      const progress = attempt !== null && max !== null ? ` (attempt ${attempt} of ${max})` : "";
      return [{ type: "status", message: `The API request failed; retrying${progress}` }];
    }
    return [];
  }

  private assistant(message: Json): AgentRunEvent[] {
    const subagentId = str(message.parent_tool_use_id);
    const content = isObject(message.message) ? message.message.content : null;
    if (!Array.isArray(content)) return [];
    const events: AgentRunEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text") {
        const text = str(block.text)?.trim();
        if (text) {
          events.push({
            type: "text",
            text: clip(redactSecrets(text), MAX_TEXT_CHARS),
            subagentId,
          });
        }
      } else if (block.type === "tool_use") {
        const id = str(block.id);
        const name = str(block.name);
        if (!id || !name || name === STRUCTURED_OUTPUT_TOOL) continue;
        if (DELEGATION_TOOLS.has(name)) {
          const input = isObject(block.input) ? block.input : {};
          const delegation = {
            name: oneLine(str(input.subagent_type) ?? "general-purpose", MAX_SUMMARY_CHARS),
            description: oneLine(str(input.description) ?? "", MAX_SUMMARY_CHARS),
          };
          this.openDelegations.set(id, delegation);
          events.push({ type: "subagent", phase: "start", id, ...delegation });
        } else {
          events.push({
            type: "tool",
            id,
            name,
            summary: summarizeToolInput(name, block.input, this.cwd),
            subagentId,
          });
        }
      }
    }
    return events;
  }

  private user(message: Json): AgentRunEvent[] {
    const content = isObject(message.message) ? message.message.content : null;
    if (!Array.isArray(content)) return [];
    const events: AgentRunEvent[] = [];
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const delegation = id ? this.openDelegations.get(id) : undefined;
      if (!id || !delegation) continue;
      this.openDelegations.delete(id);
      events.push({
        type: "subagent",
        phase: "stop",
        id,
        ...delegation,
        failed: block.is_error === true,
      });
    }
    return events;
  }

  private result(message: Json): ClaudeStreamResult {
    return {
      isError: message.is_error === true,
      subtype: str(message.subtype),
      text: clip(redactSecrets(str(message.result) ?? ""), MAX_TEXT_CHARS),
      structuredOutput: message.structured_output ?? null,
      costUsd: num(message.total_cost_usd),
      durationMs: num(message.duration_ms),
      sessionId: str(message.session_id),
    };
  }
}
