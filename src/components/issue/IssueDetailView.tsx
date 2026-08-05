import { useEffect, useState } from "react";
import { issueDetail, updateIssue } from "../../lib/issues/api";
import type { IssueDetail, IssueSummary, IssueUpdateInput } from "../../lib/issues/types";
import { useGithubStartWork } from "../../lib/issues/useStartWork";
import { formatRelativeTime } from "../../lib/time";
import { openExternal } from "../../lib/url";
import Markdown from "../Markdown";

const fieldInput =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100";

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
 * The issue detail view: title, labels, assignees, body, and comments, plus
 * editing (title, description, open/closed state) and the "Start work" action
 * that opens a workspace and launches a Claude session seeded with the issue.
 * Fetches full detail (body + comments) on mount; the `summary` prop renders
 * the header immediately while that loads.
 */
export default function IssueDetailView({
  summary,
  onBack,
  onStarted,
  onChanged,
}: {
  summary: IssueSummary;
  onBack: () => void;
  /** Called after work is started, so the list can refresh its link badges. */
  onStarted?: () => void;
  /** Called after the issue itself is edited, so the list can re-fetch. */
  onChanged?: () => void;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  const [busyField, setBusyField] = useState(false);
  const startFlow = useGithubStartWork(onStarted);
  const starting = startFlow.startingKey !== null;

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

  const title = detail?.title ?? summary.title;
  const state = detail?.state ?? summary.state;

  /** Applies a partial edit and adopts the fresh detail the route returns. */
  const applyEdit = async (input: IssueUpdateInput, after?: () => void) => {
    setBusyField(true);
    setError(null);
    try {
      setDetail(await updateIssue(summary.sourceKey, summary.externalId, input, summary.provider));
      after?.();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyField(false);
    }
  };

  const saveTitle = () => {
    if (!titleDraft.trim()) return;
    return applyEdit({ title: titleDraft.trim() }, () => setEditingTitle(false));
  };

  const saveBody = () => applyEdit({ body: bodyDraft }, () => setEditingBody(false));

  const toggleState = () => applyEdit({ state: state === "open" ? "closed" : "open" });

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
              state === "open" ? "bg-emerald-900 text-emerald-200" : "bg-zinc-700 text-zinc-300"
            }`}
          >
            {state}
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
              onClick={() => void toggleState()}
              // Gated on `detail` so the label can't act on a state the list
              // fetched before someone else closed the issue.
              disabled={busyField || !detail}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {state === "open" ? "Close issue" : "Reopen issue"}
            </button>
            <button
              type="button"
              onClick={() => void startFlow.start(summary, { title, body: detail?.body })}
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
            {editingTitle ? (
              <div className="flex items-start gap-2">
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  className={fieldInput}
                />
                <button
                  type="button"
                  onClick={() => void saveTitle()}
                  disabled={busyField || !titleDraft.trim()}
                  className="rounded-md bg-indigo-600 px-2 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busyField ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingTitle(false)}
                  className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="group flex items-start gap-2">
                <h1 className="text-lg font-medium text-zinc-100">{title}</h1>
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(title);
                    setEditingTitle(true);
                  }}
                  className="mt-1 text-xs text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-300"
                  title="Edit title"
                >
                  ✎
                </button>
              </div>
            )}
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

          {startFlow.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
              {startFlow.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          )}
          {(error ?? startFlow.error) && (
            <p className="text-sm text-red-400">{error ?? startFlow.error}</p>
          )}

          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Description
              </h3>
              {detail && !editingBody && (
                <button
                  type="button"
                  onClick={() => {
                    setBodyDraft(detail.body);
                    setEditingBody(true);
                  }}
                  className="text-xs text-zinc-600 hover:text-zinc-300"
                  title="Edit description"
                >
                  ✎
                </button>
              )}
            </div>
            {!detail ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : editingBody ? (
              <div className="space-y-2">
                <textarea
                  value={bodyDraft}
                  onChange={(e) => setBodyDraft(e.target.value)}
                  rows={10}
                  className={fieldInput}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void saveBody()}
                    disabled={busyField}
                    className="rounded-md bg-indigo-600 px-2 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {busyField ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingBody(false)}
                    className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
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
