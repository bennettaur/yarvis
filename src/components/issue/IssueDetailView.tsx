import { useEffect, useState } from "react";
import { issueDetail, startWork } from "../../lib/issues/api";
import type { IssueDetail, IssueSummary } from "../../lib/issues/types";
import { requestOpenWorkspace } from "../../lib/nav";
import { formatRelativeTime } from "../../lib/time";
import { openExternal } from "../../lib/url";
import Markdown from "../Markdown";

function LabelPill({ name, color }: { name: string; color: string | null }) {
  // `22` is the alpha byte (~13%) for a faint tinted background behind the text.
  const style = color ? { backgroundColor: `#${color}22`, color: `#${color}` } : undefined;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs ${color ? "" : "bg-zinc-800 text-zinc-400"}`}
      style={style}
    >
      {name}
    </span>
  );
}

/**
 * The issue detail view: title, labels, assignees, body, and comments, plus the
 * "Start work" action that opens a workspace and launches a Claude session
 * seeded with the issue. Fetches full detail (body + comments) on mount; the
 * `summary` prop renders the header immediately while that loads.
 */
export default function IssueDetailView({
  summary,
  onBack,
  onStarted,
}: {
  summary: IssueSummary;
  onBack: () => void;
  /** Called after work is started, so the list can refresh its link badges. */
  onStarted?: () => void;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    issueDetail(summary.sourceKey, summary.externalId, summary.provider)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [summary.sourceKey, summary.externalId, summary.provider]);

  const onStartWork = async () => {
    setStarting(true);
    setError(null);
    setWarnings([]);
    try {
      const result = await startWork(
        {
          sourceKey: summary.sourceKey,
          externalId: summary.externalId,
          title: summary.title,
          body: detail?.body ?? "",
          url: summary.url,
        },
        summary.provider,
      );
      setWarnings(result.warnings);
      onStarted?.();
      // Hand off to the Workspaces tab, which provisions the worktree and
      // launches a Claude session seeded with the issue prompt.
      requestOpenWorkspace({ id: result.workspaceId, claudePrompt: result.prompt });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const labels = detail?.labels ?? summary.labels;
  const assignees = detail?.assignees ?? summary.assignees;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            ← Back
          </button>
          <span className="text-xs text-zinc-500">
            {summary.sourceLabel} · {summary.displayId}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${
              summary.state === "open"
                ? "bg-emerald-900 text-emerald-200"
                : "bg-zinc-700 text-zinc-300"
            }`}
          >
            {summary.state}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => openExternal(summary.url)}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Open on GitHub ↗
            </button>
            <button
              type="button"
              onClick={() => void onStartWork()}
              disabled={starting}
              className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {starting ? "Starting…" : "Start work"}
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <div>
            <h1 className="text-lg font-medium text-zinc-100">{summary.title}</h1>
            <p className="mt-1 text-xs text-zinc-500">
              {summary.author} opened this {formatRelativeTime(summary.createdAt)}
            </p>
          </div>

          {(labels.length > 0 || assignees.length > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              {labels.map((l) => (
                <LabelPill key={l.name} name={l.name} color={l.color} />
              ))}
              {assignees.length > 0 && (
                <span className="text-xs text-zinc-500">assigned: {assignees.join(", ")}</span>
              )}
            </div>
          )}

          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
              {warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}

          <section>
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
              Description
            </h3>
            {!detail ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : detail.body.trim() ? (
              <Markdown allowImages>{detail.body}</Markdown>
            ) : (
              <p className="text-sm text-zinc-600">No description.</p>
            )}
          </section>

          {detail && detail.comments.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
                Comments ({detail.comments.length})
              </h3>
              <div className="space-y-3">
                {detail.comments.map((c, i) => (
                  <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                    <div className="mb-1 text-xs text-zinc-400">
                      {c.author} · {formatRelativeTime(c.createdAt)}
                    </div>
                    <Markdown allowImages>{c.body}</Markdown>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
