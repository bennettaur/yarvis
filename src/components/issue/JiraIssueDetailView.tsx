import { useEffect, useRef, useState } from "react";
import type { IssueSummary } from "../../lib/issues/types";
import {
  jiraAddComment,
  jiraAssign,
  jiraAssignableUsers,
  jiraIssueDetail,
  jiraStartWork,
  jiraTransition,
  jiraUpdateFields,
} from "../../lib/jira/api";
import type { JiraIssueDetail, JiraUser } from "../../lib/jira/types";
import { requestOpenWorkspace } from "../../lib/nav";
import { formatRelativeTime } from "../../lib/time";
import { openExternal } from "../../lib/url";
import Markdown from "../Markdown";
import JiraRepoPickerModal, { type StartWorkChoice } from "./JiraRepoPickerModal";
import { StatusBadge } from "./jiraStatus";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const fieldInput =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100";

/** Small editable-assignee control: shows the current assignee and, when
 *  editing, searches assignable users and lets you pick one or unassign. */
function AssigneeEditor({
  issueKey,
  assignee,
  onAssigned,
}: {
  issueKey: string;
  assignee: string | null;
  onAssigned: (detail: JiraIssueDetail) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JiraUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Dismiss the open dropdown on an outside click or Escape.
  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node))
        setEditing(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditing(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    let live = true;
    const handle = setTimeout(() => {
      jiraAssignableUsers(issueKey, query)
        .then((users) => live && setResults(users))
        .catch((e) => live && setError(errMsg(e)));
    }, 250);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [editing, query, issueKey]);

  const pick = async (accountId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await jiraAssign(issueKey, accountId);
      onAssigned(updated);
      setEditing(false);
      setQuery("");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-zinc-300 hover:text-zinc-100"
        title="Change assignee"
      >
        {assignee ?? "Unassigned"} <span className="text-zinc-600">✎</span>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <input
        // biome-ignore lint/a11y/noAutofocus: focus the search field when the picker opens
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search users…"
        className="w-48 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
      />
      <div className="absolute z-10 mt-1 max-h-60 w-56 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-lg">
        {error && <p className="px-2 py-1 text-xs text-red-400">{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void pick(null)}
          className="block w-full px-2 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-800"
        >
          Unassign
        </button>
        {results.map((u) => (
          <button
            key={u.accountId}
            type="button"
            disabled={busy}
            onClick={() => void pick(u.accountId)}
            className="block w-full px-2 py-1.5 text-left hover:bg-zinc-800"
          >
            <span className="block text-sm text-zinc-200">{u.displayName}</span>
            {u.email && <span className="block text-xs text-zinc-500">{u.email}</span>}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="block w-full border-t border-zinc-800 px-2 py-1 text-left text-xs text-zinc-500 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The JIRA issue detail view. Renders the ticket's fields (status, type,
 * priority, assignee, reporter, labels), description, linked issues, and
 * comments, and lets the user edit the summary, description, status (via
 * transitions), assignee, and labels, add comments, open the ticket in JIRA, and
 * start work — which opens a repo picker and hands off to the Workspaces tab.
 */
export default function JiraIssueDetailView({
  summary,
  onBack,
  onStarted,
}: {
  summary: IssueSummary;
  onBack: () => void;
  onStarted?: () => void;
}) {
  const [detail, setDetail] = useState<JiraIssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Field editors.
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [editingLabels, setEditingLabels] = useState(false);
  const [labelsDraft, setLabelsDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [savingComment, setSavingComment] = useState(false);
  const [busyField, setBusyField] = useState(false);

  // Start-work flow.
  const [pickingRepos, setPickingRepos] = useState(false);
  const [starting, setStarting] = useState(false);

  const key = summary.externalId;

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    jiraIssueDetail(key)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(errMsg(e)));
    return () => {
      live = false;
    };
  }, [key]);

  const apply = (updated: JiraIssueDetail) => {
    setDetail(updated);
    setError(null);
  };

  const runField = async (fn: () => Promise<JiraIssueDetail>, after?: () => void) => {
    setBusyField(true);
    setError(null);
    try {
      apply(await fn());
      after?.();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusyField(false);
    }
  };

  const saveSummary = () =>
    runField(
      () => jiraUpdateFields(key, { summary: summaryDraft.trim() }),
      () => setEditingSummary(false),
    );

  const saveDescription = () =>
    runField(
      () => jiraUpdateFields(key, { description: descDraft }),
      () => setEditingDesc(false),
    );

  const saveLabels = () => {
    const labels = labelsDraft
      .split(/[\s,]+/)
      .map((l) => l.trim())
      .filter(Boolean);
    return runField(
      () => jiraUpdateFields(key, { labels }),
      () => setEditingLabels(false),
    );
  };

  const changeStatus = (transitionId: string) => {
    if (!transitionId) return;
    void runField(() => jiraTransition(key, transitionId));
  };

  const addComment = async () => {
    if (!commentDraft.trim()) return;
    setSavingComment(true);
    setError(null);
    try {
      await jiraAddComment(key, commentDraft.trim());
      setCommentDraft("");
      // Re-fetch so the new comment (and its server-side id/timestamp) shows.
      apply(await jiraIssueDetail(key));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSavingComment(false);
    }
  };

  const startWork = async (choice: StartWorkChoice) => {
    if (!detail) return;
    setStarting(true);
    setError(null);
    setWarnings([]);
    try {
      const result = await jiraStartWork({
        sourceKey: detail.sourceKey,
        externalId: detail.externalId,
        title: detail.title,
        body: detail.body,
        url: detail.url,
        repoIds: choice.repoIds,
        transitionToInProgress: choice.transitionToInProgress,
        transitionId: choice.transitionId,
      });
      setWarnings(result.warnings);
      setPickingRepos(false);
      onStarted?.();
      requestOpenWorkspace({ id: result.workspaceId, claudePrompt: result.prompt });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setStarting(false);
    }
  };

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
            {detail?.sourceLabel ?? summary.sourceLabel} · {detail?.displayId ?? summary.displayId}
          </span>
          {detail && (
            <StatusBadge name={detail.statusName ?? ""} category={detail.statusCategory} />
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => openExternal(detail?.url ?? summary.url)}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Open in JIRA ↗
            </button>
            <button
              type="button"
              onClick={() => setPickingRepos(true)}
              disabled={starting || !detail}
              className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {starting ? "Starting…" : "Start work"}
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {/* Summary */}
          <div>
            {editingSummary ? (
              <div className="flex items-start gap-2">
                <input
                  value={summaryDraft}
                  onChange={(e) => setSummaryDraft(e.target.value)}
                  className={fieldInput}
                />
                <button
                  type="button"
                  onClick={() => void saveSummary()}
                  disabled={busyField || !summaryDraft.trim()}
                  className="rounded-md bg-indigo-600 px-2 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busyField ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingSummary(false)}
                  className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="group flex items-start gap-2">
                <h1 className="text-lg font-medium text-zinc-100">
                  {detail?.title ?? summary.title}
                </h1>
                <button
                  type="button"
                  onClick={() => {
                    setSummaryDraft(detail?.title ?? summary.title);
                    setEditingSummary(true);
                  }}
                  className="mt-1 text-xs text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-300"
                  title="Edit summary"
                >
                  ✎
                </button>
              </div>
            )}
            <p className="mt-1 text-xs text-zinc-500">
              {detail?.issueType && <span>{detail.issueType} · </span>}
              {summary.author} opened this {formatRelativeTime(summary.createdAt)}
            </p>
          </div>

          {/* Field grid: status, assignee, reporter, priority */}
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm sm:grid-cols-4">
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Status</div>
              {detail && detail.transitions.length > 0 ? (
                <select
                  value=""
                  onChange={(e) => changeStatus(e.target.value)}
                  disabled={busyField}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-sm"
                >
                  <option value="">{detail.statusName}</option>
                  {detail.transitions.map((t) => (
                    <option key={t.id} value={t.id}>
                      → {t.toStatusName}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-zinc-300">{detail?.statusName ?? "…"}</span>
              )}
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Assignee</div>
              {detail ? (
                <AssigneeEditor issueKey={key} assignee={detail.assignee} onAssigned={apply} />
              ) : (
                <span className="text-zinc-500">…</span>
              )}
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Reporter</div>
              <span className="text-zinc-300">{detail?.reporter ?? summary.author}</span>
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Priority</div>
              <span className="text-zinc-300">{detail?.priority ?? "—"}</span>
            </div>
          </div>

          {/* Labels */}
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
              Labels
              {!editingLabels && (
                <button
                  type="button"
                  onClick={() => {
                    setLabelsDraft((detail?.labels ?? summary.labels).map((l) => l.name).join(" "));
                    setEditingLabels(true);
                  }}
                  className="normal-case text-zinc-600 hover:text-zinc-300"
                  title="Edit labels"
                >
                  ✎
                </button>
              )}
            </div>
            {editingLabels ? (
              <div className="flex items-center gap-2">
                <input
                  value={labelsDraft}
                  onChange={(e) => setLabelsDraft(e.target.value)}
                  placeholder="space-separated labels"
                  className={fieldInput}
                />
                <button
                  type="button"
                  onClick={() => void saveLabels()}
                  disabled={busyField}
                  className="rounded-md bg-indigo-600 px-2 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busyField ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingLabels(false)}
                  className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            ) : (detail?.labels ?? summary.labels).length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {(detail?.labels ?? summary.labels).map((l) => (
                  <span
                    key={l.name}
                    className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300"
                  >
                    {l.name}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-sm text-zinc-600">No labels.</span>
            )}
          </div>

          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
              {warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}

          {/* Description */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Description
              </h3>
              {detail && !editingDesc && (
                <button
                  type="button"
                  onClick={() => {
                    setDescDraft(detail.body);
                    setEditingDesc(true);
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
            ) : editingDesc ? (
              <div className="space-y-2">
                <textarea
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  rows={8}
                  className={fieldInput}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void saveDescription()}
                    disabled={busyField}
                    className="rounded-md bg-indigo-600 px-2 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {busyField ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingDesc(false)}
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

          {/* Linked issues */}
          {detail && detail.linkedIssues.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
                Linked issues
              </h3>
              <ul className="space-y-1">
                {detail.linkedIssues.map((l) => (
                  <li
                    key={`${l.linkType}:${l.key}`}
                    className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm"
                  >
                    <span className="text-xs text-zinc-500">{l.linkType}</span>
                    <button
                      type="button"
                      onClick={() => openExternal(l.url)}
                      className="font-mono text-xs text-sky-400 hover:underline"
                    >
                      {l.key}
                    </button>
                    <span className="truncate text-zinc-300">{l.summary}</span>
                    <StatusBadge name={l.statusName} category={l.statusCategory} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Comments */}
          <section>
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
              Comments {detail ? `(${detail.comments.length})` : ""}
            </h3>
            <div className="space-y-3">
              {detail?.comments.map((c, i) => (
                <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  <div className="mb-1 text-xs text-zinc-400">
                    {c.author} · {formatRelativeTime(c.createdAt)}
                  </div>
                  <Markdown allowImages>{c.body}</Markdown>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-2">
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Add a comment…"
                rows={3}
                className={fieldInput}
              />
              <button
                type="button"
                onClick={() => void addComment()}
                disabled={savingComment || !commentDraft.trim()}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
              >
                {savingComment ? "Posting…" : "Comment"}
              </button>
            </div>
          </section>
        </div>
      </div>

      {pickingRepos && detail && (
        <JiraRepoPickerModal
          projectKey={detail.sourceKey}
          issueKey={detail.displayId}
          transitions={detail.transitions}
          busy={starting}
          onConfirm={(choice) => void startWork(choice)}
          onClose={() => setPickingRepos(false)}
        />
      )}
    </div>
  );
}
