import { describeError, redactSecrets } from "../llm/errors.ts";

/**
 * An in-memory tail of everything the sidecar logged, so the app can show the
 * user what happened without them running the process from a terminal: a
 * packaged build's stdout goes nowhere they can reach.
 *
 * Capture works by wrapping `console`, not by a logging API of its own: every
 * log line in the sidecar is already written where something went wrong, and a
 * parallel API would only be adopted by the code that remembered to.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** Monotonic within a process run; the cursor a poller passes back as `after`. */
  seq: number;
  at: string;
  level: LogLevel;
  /** The `[chat]`-style prefix the line opened with, if any. */
  scope: string | null;
  message: string;
}

/** Entries kept in memory. A few thousand lines covers a session's worth of work. */
const CAPACITY = 2000;
/** Longest single line retained; a stray dump can't push the useful lines out. */
const MAX_LINE = 8000;

const entries: LogEntry[] = [];
let nextSeq = 1;

/** Leading `[scope]`, as every hand-written log line in the sidecar is prefixed. */
const SCOPE = /^\[([a-z0-9:_-]{1,32})\]\s*/i;

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return describeError(value);
  try {
    return Bun.inspect(value, { depth: 3 });
  } catch {
    return String(value);
  }
}

export function record(level: LogLevel, args: unknown[]): void {
  // Redact before truncating: a credential straddling the cut would otherwise
  // lose the tail that makes it match, and half a token is still a leak.
  const redacted = redactSecrets(args.map(render).join(" "));
  const capped = redacted.length > MAX_LINE ? `${redacted.slice(0, MAX_LINE)}…` : redacted;
  const scoped = SCOPE.exec(capped);
  entries.push({
    seq: nextSeq++,
    at: new Date().toISOString(),
    level,
    scope: scoped?.[1] ?? null,
    message: scoped ? capped.slice(scoped[0].length) : capped,
  });
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);
}

export interface LogQuery {
  /** Lowest level to include, in `debug < info < warn < error` order. */
  minLevel?: LogLevel;
  /** Only lines from this scope. */
  scope?: string;
  /** Only lines whose message contains this text, case-insensitively. */
  contains?: string;
  /** Only entries newer than this `seq`, for polling without re-reading the tail. */
  after?: number;
  limit?: number;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** The most recent matching entries, oldest first. */
export function recentLogs(query: LogQuery = {}): LogEntry[] {
  const min = RANK[query.minLevel ?? "debug"];
  const needle = query.contains?.toLowerCase();
  const matched = entries.filter(
    (e) =>
      RANK[e.level] >= min &&
      (!query.scope || e.scope === query.scope) &&
      (query.after === undefined || e.seq > query.after) &&
      (!needle || e.message.toLowerCase().includes(needle)),
  );
  const limit = query.limit ?? 500;
  return matched.slice(-limit);
}

/** Every scope seen so far, for a filter the user picks from. */
export function knownScopes(): string[] {
  return Array.from(
    new Set(entries.map((e) => e.scope).filter((s): s is string => s !== null)),
  ).sort();
}

/** Test seam: drops the captured tail. */
export function clearLogs(): void {
  entries.length = 0;
  nextSeq = 1;
}

let installed = false;

/**
 * Tees `console` into the buffer above, keeping the original write so a dev run
 * and the core's log file still see everything. Idempotent.
 */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  const levels: Array<[LogLevel, "log" | "info" | "warn" | "error" | "debug"]> = [
    ["info", "log"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
    ["debug", "debug"],
  ];
  for (const [level, method] of levels) {
    // biome-ignore lint/suspicious/noConsole: wrapping console is the point
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      record(level, args);
      original(...args);
    };
  }
}
