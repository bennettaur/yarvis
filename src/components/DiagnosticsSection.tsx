import { useCallback, useEffect, useRef, useState } from "react";
import { type DisplayError, formatError } from "../lib/errors";
import { formatEntry, getLogs, type LogEntry, type LogLevel, sidecarLogPath } from "../lib/logs";
import CopyButton from "./CopyButton";
import ErrorNotice from "./ErrorNotice";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
/** How often the tail refreshes while following. */
const POLL_MS = 2000;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "text-zinc-500",
  info: "text-zinc-400",
  warn: "text-amber-400",
  error: "text-red-400",
};

/**
 * The sidecar's log, read from inside the app. A packaged build has no terminal
 * attached, so until now a failure that printed a perfectly good explanation
 * left the user with nothing to read — and nothing to attach to a bug report.
 *
 * The tail here is the sidecar's in-memory buffer, which resets when it
 * restarts; the file path shown at the bottom is the durable copy the core
 * writes, which is the one that survives the crash worth reporting.
 */
export default function DiagnosticsSection() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [minLevel, setMinLevel] = useState<LogLevel>("info");
  const [scope, setScope] = useState("");
  const [contains, setContains] = useState("");
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<DisplayError | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await getLogs({
        minLevel,
        scope: scope || undefined,
        contains: contains || undefined,
      });
      setEntries(page.entries);
      setScopes(page.scopes);
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  }, [minLevel, scope, contains]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!follow) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [follow, refresh]);

  useEffect(() => {
    sidecarLogPath()
      .then(setLogPath)
      .catch(() => setLogPath(null));
  }, []);

  // Keep the newest line in view while following, not while reading back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run as the tail grows
  useEffect(() => {
    if (follow) tailRef.current?.scrollTo(0, tailRef.current.scrollHeight);
  }, [entries, follow]);

  const asText = () => entries.map(formatEntry).join("\n");

  return (
    <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-zinc-200">Sidecar log</h2>
        <span className="text-xs text-zinc-500">{entries.length} lines</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as LogLevel)}
            aria-label="Minimum level"
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs"
          >
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {level} and above
              </option>
            ))}
          </select>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            aria-label="Scope"
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs"
          >
            <option value="">all scopes</option>
            {scopes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            value={contains}
            onChange={(e) => setContains(e.target.value)}
            placeholder="filter text"
            aria-label="Filter text"
            className="w-36 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none focus:border-zinc-500"
          />
          <label className="flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow
          </label>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Refresh
          </button>
          <CopyButton value={asText} subject="log" />
        </div>
      </div>

      {error && <ErrorNotice error={error} onDismiss={() => setError(null)} />}

      <div
        ref={tailRef}
        className="h-80 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 font-mono text-xs"
      >
        {entries.length === 0 ? (
          <p className="text-zinc-600">Nothing logged at this level yet.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.seq} className="whitespace-pre-wrap break-all">
              <span className="text-zinc-600">{entry.at.slice(11, 23)} </span>
              <span className={LEVEL_COLOR[entry.level]}>{entry.level.toUpperCase()} </span>
              {entry.scope && <span className="text-sky-400">[{entry.scope}] </span>}
              <span className="text-zinc-300">{entry.message}</span>
            </div>
          ))
        )}
      </div>

      {logPath && (
        <p className="flex items-center gap-2 text-xs text-zinc-500">
          Kept across restarts at <code className="text-zinc-400">{logPath}</code>
          <CopyButton value={logPath} subject="log path" />
        </p>
      )}
    </section>
  );
}
