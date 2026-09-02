import { useState } from "react";
import { type DisplayError, errorText } from "../lib/errors";
import CopyButton from "./CopyButton";

/**
 * How a failure is shown anywhere in the app: the readable line always, and the
 * full diagnosis — provider status, endpoint, response body, cause chain —
 * behind a disclosure with a copy button. A bare "there was an error" leaves the
 * user no way to tell a misconfigured gateway from an outage, so the detail is
 * always one click away rather than only in a log the packaged app doesn't keep.
 *
 * `actions` hangs affordances that belong with the failure (retry, open
 * settings) off the same row.
 *
 * An error with `tone: "notice"` is not a failure — a turn the user stopped —
 * so it drops the red, the alert role and the copy button, which would otherwise
 * announce the user's own deliberate action as something that went wrong.
 */
export default function ErrorNotice({
  error,
  onDismiss,
  actions,
  className = "",
}: {
  error: DisplayError;
  onDismiss?: () => void;
  actions?: React.ReactNode;
  className?: string;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const notice = error.tone === "notice";

  return (
    <div
      role={notice ? "status" : "alert"}
      className={`rounded-lg border p-3 text-sm ${
        notice ? "border-zinc-700 bg-zinc-900/60" : "border-red-900/60 bg-red-950/30"
      } ${className}`}
    >
      <div className="flex items-start gap-2">
        <p className={`flex-1 whitespace-pre-wrap ${notice ? "text-zinc-300" : "text-red-300"}`}>
          {error.message}
        </p>
        {!notice && <CopyButton value={() => errorText(error)} subject="error details" />}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={notice ? "Dismiss notice" : "Dismiss error"}
            className="shrink-0 rounded px-1 text-zinc-500 hover:text-zinc-200"
          >
            ×
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {actions}
        {error.detail && (
          <button
            type="button"
            onClick={() => setShowDetail((open) => !open)}
            aria-expanded={showDetail}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {showDetail ? "Hide details" : "Show details"}
          </button>
        )}
      </div>
      {showDetail && error.detail && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-900 p-2 text-xs text-zinc-400">
          {error.detail}
        </pre>
      )}
    </div>
  );
}
