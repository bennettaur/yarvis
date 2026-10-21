import { useCallback, useEffect, useState } from "react";
import {
  decidePermission,
  getPermissionRequests,
  type PermissionDecision,
  type PermissionRequest,
} from "../../lib/attention";
import { formatRelativeTime } from "../../lib/time";

/** How often the open modal re-reads the queue, so a prompt answered in the terminal drops out. */
const REFRESH_MS = 2_000;

/** How long a newly promoted request ignores clicks, so a double click can't approve the next one. */
const ARMING_MS = 400;

/**
 * Answers a Claude Code session's permission prompt without leaving the page
 * the user is on. Opened from a `permission` item in the attention panel, for
 * the session that raised it. Shows the front of that session's queue: the
 * tool and its input, where it runs, and what the agent said just before
 * asking, with the same choices Claude Code's own dialog offers.
 *
 * The session's hook only waits a few minutes. Past that, or once the prompt
 * is answered in the terminal, the request is gone and the modal says so.
 */
export default function PermissionRequestModal({
  sessionKey,
  title,
  onClose,
  onGoToSession,
}: {
  /** The session whose prompts to show; null keeps the modal closed. */
  sessionKey: string | null;
  /** The attention item's title, shown until the first request loads. */
  title: string;
  onClose: () => void;
  /** Opens the terminal the session runs in. */
  onGoToSession: () => void;
}) {
  const [requests, setRequests] = useState<PermissionRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const current = requests?.[0] ?? null;

  const refresh = useCallback(async () => {
    if (!sessionKey) return;
    try {
      setRequests(await getPermissionRequests(sessionKey));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionKey]);

  useEffect(() => {
    setRequests(null);
    setError(null);
    if (!sessionKey) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [sessionKey, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm per request
  useEffect(() => {
    setArmed(false);
    setMessage("");
    const timer = setTimeout(() => setArmed(true), ARMING_MS);
    return () => clearTimeout(timer);
  }, [current?.id]);

  useEffect(() => {
    if (!sessionKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionKey, onClose]);

  if (!sessionKey) return null;

  const answer = async (decision: PermissionDecision) => {
    if (!current || !armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const delivered = await decidePermission(current.id, decision);
      if (!delivered) setError("That prompt was already answered or timed out.");
      const remaining = await getPermissionRequests(sessionKey);
      setRequests(remaining);
      if (decision.behavior === "terminal") onGoToSession();
      else if (delivered && remaining.length === 0) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disabled = !armed || busy;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <button
        type="button"
        aria-label="Close permission request"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Permission request"
        className="relative flex max-h-[85vh] w-[640px] max-w-full flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-amber-400">Permission needed</div>
            <div className="truncate text-sm font-medium text-zinc-100">
              {current?.workspaceName ?? title}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {requests && requests.length > 1 && (
              <span className="text-xs text-zinc-400">+{requests.length - 1} waiting</span>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-zinc-500 hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
          {requests === null && !error && <p className="text-xs text-zinc-500">Loading…</p>}
          {requests !== null && !current && (
            <p className="text-xs text-zinc-400">
              This session isn't waiting on Yarvis any more. It was answered in the terminal, or
              waited too long and handed the prompt back to it. Open the session to see where it is.
            </p>
          )}
          {current && <RequestDetails request={current} />}
          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}
        </div>

        <footer className="shrink-0 space-y-2 border-t border-zinc-800 px-4 py-3">
          {current && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const text = message.trim();
                if (text) void answer({ behavior: "deny", message: text });
              }}
              className="flex gap-2"
            >
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="No, and tell Claude what to do instead…"
                aria-label="Tell Claude what to do instead"
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={disabled || !message.trim()}
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                Send
              </button>
            </form>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onGoToSession}
              title="Open the terminal this session runs in, without answering."
              className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            >
              Go to session
            </button>
            {current && (
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void answer({ behavior: "terminal" })}
                  disabled={disabled}
                  title="Show this prompt in the terminal instead, with all of Claude Code's options."
                  className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
                >
                  Answer in terminal
                </button>
                <button
                  type="button"
                  onClick={() => void answer({ behavior: "deny" })}
                  disabled={disabled}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={() => void answer({ behavior: "allow" })}
                  disabled={disabled}
                  className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  Approve
                </button>
              </div>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function RequestDetails({ request }: { request: PermissionRequest }) {
  const command = typeof request.toolInput.command === "string" ? request.toolInput.command : null;
  const description =
    typeof request.toolInput.description === "string" ? request.toolInput.description : null;
  // Bash shows its command on its own; other tools show their whole input.
  const input = command ?? JSON.stringify(request.toolInput, null, 2);

  return (
    <>
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="font-medium text-zinc-100">{request.toolName}</span>
          <span className="text-[11px] text-zinc-500">{formatRelativeTime(request.createdAt)}</span>
        </div>
        {description && <p className="mb-1 text-xs text-zinc-400">{description}</p>}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950/70 p-2 font-mono text-xs text-zinc-200">
          {input}
        </pre>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {request.cwd && (
          <>
            <dt className="text-zinc-500">Directory</dt>
            <dd className="truncate text-zinc-300" title={request.cwd}>
              {request.cwd}
            </dd>
          </>
        )}
        {request.permissionMode && (
          <>
            <dt className="text-zinc-500">Mode</dt>
            <dd className="text-zinc-300">{request.permissionMode}</dd>
          </>
        )}
      </dl>

      {request.lastReply && (
        <div>
          <div className="mb-1 text-xs text-zinc-500">What Claude said before asking</div>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-zinc-800 p-2 text-xs text-zinc-300">
            {request.lastReply}
          </p>
        </div>
      )}
      {request.lastPrompt && (
        <div>
          <div className="mb-1 text-xs text-zinc-500">Your last prompt</div>
          <p className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-zinc-400">
            {request.lastPrompt}
          </p>
        </div>
      )}
    </>
  );
}
