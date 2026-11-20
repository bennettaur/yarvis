import type { ReactNode } from "react";
import { ThreadView } from "../../pr/ThreadView";
import type { FileAnnotations } from "./useFileAnnotations";

/** A message in the editor's place: loading, an error, a file that can't be shown. */
export function CenteredNote({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={`flex h-full items-center justify-center p-6 text-center text-sm ${
        tone === "error" ? "text-red-400" : "text-zinc-500"
      }`}
    >
      {children}
    </div>
  );
}

/**
 * What sits between a file tab's toolbar and its editor: why a line action did
 * nothing, a write that failed, and the threads that no longer have a line to
 * hang under. Outdated threads stay folded behind a count — they are still
 * worth answering, but rarely the first thing to read.
 */
export function AnnotationBar({
  annotations,
  error,
}: {
  annotations: FileAnnotations;
  error?: string | null;
}) {
  const { notice, outdated, outdatedActions } = annotations;
  if (!notice && !error && outdated.length === 0) return null;
  return (
    <div className="space-y-1 border-b border-zinc-800 px-3 py-1.5 text-xs">
      {notice && (
        <div className="flex items-center gap-2 text-zinc-400">
          {notice}
          <button
            type="button"
            onClick={annotations.dismissNotice}
            aria-label="Dismiss"
            className="text-zinc-500 hover:text-zinc-300"
          >
            ✕
          </button>
        </div>
      )}
      {error && <div className="text-red-400">{error}</div>}
      {outdated.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-1 text-zinc-400 hover:text-zinc-200">
            <span className="inline-block transition-transform group-open:rotate-90">▶</span>
            {outdated.length} outdated {outdated.length === 1 ? "thread" : "threads"}
            {outdated.some((t) => !t.isResolved) && (
              <span className="ml-1 text-amber-400">
                ({outdated.filter((t) => !t.isResolved).length} open)
              </span>
            )}
          </summary>
          <div className="mt-2 max-h-80 space-y-2 overflow-y-auto pb-1">
            {outdated.map((thread, i) => (
              <ThreadView key={thread.id || `at-${i}`} {...outdatedActions.viewProps(thread)} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
