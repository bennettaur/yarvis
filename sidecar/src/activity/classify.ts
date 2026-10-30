import { basename } from "node:path";
import { z } from "zod";
import { type ActivityEvent, type ActivityType, clipLabel } from "./hub.ts";

const CLAUDE_TOOL_TYPES: [RegExp, ActivityType][] = [
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, "edit"],
  [/^(Read|Glob|Grep|LS|NotebookRead)$/, "read"],
  [/^(WebSearch|WebFetch)$/, "search"],
  [/^Bash$/, "bash"],
  [/^(Task|Agent)$/, "spawn"],
];

/**
 * Yarvis tools are classed by their name's verb, so a new tool lands somewhere
 * sensible without being listed. Order matters: `read_web_page` is a search
 * before it is a read.
 */
const YARVIS_TOOL_TYPES: [RegExp, ActivityType][] = [
  [/^delegate$/, "spawn"],
  [/^(read_web_page|recall|consult_decisions)$|search|^find_/, "search"],
  [/^(list|get|read|inspect)_|_status$|_summary$/, "read"],
  [/^(start|send|click|navigate|scroll)_/, "bash"],
  [
    /^(create|update|delete|complete|set|cancel|comment|upsert|register|track|untrack|link|unlink|schedule|post|archive|rollover|dismiss|restore|correct|forget|confirm|record)_|^(remember|take_note)$|_(comment|assign|transition)_|_(create|update)_/,
    "edit",
  ],
];

function classify(table: [RegExp, ActivityType][], name: string): ActivityType {
  return table.find(([re]) => re.test(name))?.[1] ?? "tool";
}

export const claudeToolType = (name: string) => classify(CLAUDE_TOOL_TYPES, name);
export const yarvisToolType = (name: string) => classify(YARVIS_TOOL_TYPES, name);

/**
 * The fields read from a Claude Code hook's stdin. Everything else, including
 * the full tool input of a Write, is dropped by the parse and never kept.
 */
export const claudeHookSchema = z.object({
  hook_event_name: z.string().max(64),
  session_id: z.string().max(128).optional(),
  agent_type: z.string().max(128).optional(),
  tool_name: z.string().max(256).optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  message: z.string().optional(),
});

export type ClaudeHook = z.infer<typeof claudeHookSchema>;

/** What a tool call was aimed at: a file's name, a command, a pattern or a URL. */
function toolTarget(input: Record<string, unknown> = {}): string {
  for (const key of ["file_path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value) return basename(value);
  }
  for (const key of ["command", "pattern", "query", "url", "subagent_type", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/**
 * Maps a Claude Code hook onto a page event, or null for one the page doesn't
 * draw. `workspace` names the node, with the session's first characters so two
 * sessions in one workspace orbit separately.
 */
export function fromClaudeHook(hook: ClaudeHook, workspace: string): ActivityEvent | null {
  const session = hook.session_id ? `:${hook.session_id.slice(0, 4)}` : "";
  const subagent = hook.agent_type ? `/${hook.agent_type}` : "";
  const source = clipLabel(`${workspace}${session}${subagent}`);
  const event = (type: ActivityType, label: string): ActivityEvent => ({
    origin: "claude",
    type,
    source,
    label: clipLabel(label),
  });
  const tool = hook.tool_name ?? "";
  switch (hook.hook_event_name) {
    case "UserPromptSubmit":
      return event("prompt", "prompt");
    case "PreToolUse":
      return tool ? event(claudeToolType(tool), `${tool} ${toolTarget(hook.tool_input)}`) : null;
    case "PostToolUseFailure":
      return event("error", `${tool || "tool"} failed`);
    case "SubagentStop":
      return event("subagent_done", "subagent done");
    case "Stop":
      return event("done", "turn complete");
    case "Notification":
      return event("notify", hook.message ?? "notification");
    case "SessionStart":
      return event("spawn", "session start");
    case "PreCompact":
      return event("notify", "compacting");
    default:
      return null;
  }
}
