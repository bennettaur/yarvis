import type { AgentEvent } from "../chat/agent.ts";
import { CUT_SHORT_RESULT, type ToolActivity } from "../db/schema.ts";

/**
 * What a pass did, kept even when it fails. A turn that ends on an error saves
 * nothing of its own, so the pass folds the turn's events into this record and
 * saves it itself. The record is also what tells a retry, or the next pass,
 * which calls already went through.
 */
export interface AttemptRecord {
  text: string;
  activity: ToolActivity[];
}

export function newAttemptRecord(): AttemptRecord {
  return { text: "", activity: [] };
}

/** Folds one streamed event into the record. */
export function recordEvent(record: AttemptRecord, event: AgentEvent): void {
  switch (event.type) {
    case "delta":
      record.text += event.text;
      break;
    case "tool_call":
      record.activity.push({
        id: event.id,
        name: event.name,
        server: event.server,
        args: event.args,
        status: "pending",
      });
      break;
    case "tool_result": {
      const entry = record.activity.find((a) => a.id === event.id);
      if (entry) {
        entry.status = event.status;
        entry.result = event.result;
        entry.durationMs = event.durationMs;
      }
      break;
    }
  }
}

/**
 * A call whose turn ended before its result came back. It may still have
 * taken effect, so it is neither done nor failed.
 */
export function hasNoResult(call: Pick<ToolActivity, "status" | "result">): boolean {
  return call.status === "pending" || call.result === CUT_SHORT_RESULT;
}

/** Longest a call's arguments or error are quoted back to a pass. */
const QUOTED_CHARS = 200;

/** Flattens text to one line, cut at `max` characters. */
export function clip(text: string, max = QUOTED_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Most calls listed back to a pass; past this only the count is given. */
const MAX_LISTED_CALLS = 60;

/**
 * One line per call, for a pass picking up after a failure: what was called,
 * with what, and how it ended. The arguments and errors can quote text other
 * people wrote, so callers fence the result.
 */
export function describeActivity(activity: ToolActivity[]): string {
  const lines = activity.slice(0, MAX_LISTED_CALLS).map((a) => {
    const rawArgs = typeof a.args === "string" ? a.args : JSON.stringify(a.args);
    const args = a.args === undefined ? "" : clip(rawArgs);
    const call = `${a.server ? `${a.server}/` : ""}${a.name}(${args})`;
    if (a.status === "ok") return `- done: ${call}`;
    if (hasNoResult(a)) return `- unknown (no result came back; check before repeating): ${call}`;
    const outcome = a.result ? ` → ${clip(a.result)}` : "";
    // Queued for the user's approval, refused, or denied; the result says which.
    if (a.status === "denied") return `- not run: ${call}${outcome}`;
    return `- failed: ${call}${outcome}`;
  });
  if (activity.length > MAX_LISTED_CALLS) {
    lines.push(`- and ${activity.length - MAX_LISTED_CALLS} more calls`);
  }
  return lines.join("\n");
}
