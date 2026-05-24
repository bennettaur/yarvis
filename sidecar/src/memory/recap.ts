import type { Task } from "../db/schema.ts";
import type { MemoryRecord } from "./index.ts";

export type RecapRange = "day" | "week";

export interface RecapWindow {
  from: Date;
  to: Date;
  label: string;
}

/**
 * Resolves a recap range to a concrete window. "day" covers since local
 * midnight; "week" covers since Monday of the current week. `now` is injectable
 * for deterministic tests.
 */
export function dateRange(range: RecapRange, now: Date = new Date()): RecapWindow {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  if (range === "week") {
    const daysSinceMonday = (from.getDay() + 6) % 7;
    from.setDate(from.getDate() - daysSinceMonday);
  }
  return { from, to: now, label: range === "week" ? "this week" : "today" };
}

/**
 * Builds the plain-text material a recap summarizes: completed tasks and notes
 * captured in the window. Also serves as the fallback recap when no LLM is
 * configured.
 */
export function assembleRecapContext(
  tasks: Task[],
  notes: MemoryRecord[],
): string {
  const parts: string[] = [];

  parts.push("Completed tasks:");
  if (tasks.length === 0) {
    parts.push("  (none)");
  } else {
    for (const t of tasks) {
      parts.push(`  - [${t.scope}] ${t.title}${t.notes ? ` — ${t.notes}` : ""}`);
    }
  }

  parts.push("");
  parts.push("Notes:");
  if (notes.length === 0) {
    parts.push("  (none)");
  } else {
    for (const n of notes) {
      parts.push(`  - ${n.content}`);
    }
  }

  return parts.join("\n");
}

/** The instruction given to the model to turn raw material into a recap. */
export function recapPrompt(label: string, context: string): string {
  return [
    `Write a brief, friendly recap of what I worked on ${label}.`,
    "Group related items, call out what got finished, and keep it to a few sentences or a short bulleted list.",
    "Base it only on the material below; do not invent work.",
    "",
    context,
  ].join("\n");
}
