import { type ReactNode, useEffect, useRef, useState } from "react";
import { addIssueComment, issueDetail, issueRepoMeta, updateIssue } from "../../lib/issues/api";
import type {
  IssueDetail,
  IssueRepoMeta,
  IssueSummary,
  IssueUpdateInput,
} from "../../lib/issues/types";
import { useGithubStartWork } from "../../lib/issues/useGithubStartWork";
import { formatRelativeTime } from "../../lib/time";
import { openExternal } from "../../lib/url";
import CopyLinkButton from "../CopyLinkButton";
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

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Closes an open popover on an outside click or Escape. */
function useDismissable(open: boolean, setOpen: (open: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);
  return ref;
}

/** Adds or removes one value from a picker's staged selection. */
const toggleIn = (values: string[], value: string): string[] =>
  values.includes(value) ? values.filter((v) => v !== value) : [...values, value];

/**
 * Picks a subset of the sets GitHub curates per repo — its labels and the users
 * it will accept as assignees. Both are offered as the repo's own values rather
 * than free text, so a typo can't invent a label or name an unassignable user.
 * Selections are staged in a draft and sent on Save, matching how the title and
 * description editors here work.
 *
 * `options` must already include everything currently applied to the issue: a
 * value the repo no longer offers — a label since deleted, a user who lost
 * access — still has to render, or the user cannot uncheck it and Save would
 * put it straight back.
 */
function SetPicker({
  itemNoun,
  options,
  draft,
  onToggle,
  onSave,
  onCancel,
  busy,
  loading,
  loadError,
  truncated,
  emptyText,
  renderOption,
}: {
  /** Plural noun for the options, used in the filter's accessible name. */
  itemNoun: string;
  options: string[];
  draft: string[];
  onToggle: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  loading: boolean;
  loadError: string | null;
  /** The repo offers more than `options` holds; say so rather than look complete. */
  truncated: boolean;
  /** Shown when the repo genuinely offers nothing. */
  emptyText: string;
  renderOption?: (value: string) => ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.toLowerCase().includes(needle)) : options;

  // An empty list means one of four different things, and saying the wrong one
  // is worse than saying nothing — "no labels in this repo" is a lie when the
  // filter simply matched nothing.
  const emptyReason = loadError
    ? `Could not load ${itemNoun}: ${loadError}`
    : loading
      ? "Loading…"
      : options.length === 0
        ? emptyText
        : "No matches.";

  return (
    <div className="absolute z-10 mt-1 w-64 rounded-md border border-zinc-700 bg-zinc-900 shadow-lg">
      <input
        // biome-ignore lint/a11y/noAutofocus: focus the filter when the picker opens
        autoFocus
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Filter ${itemNoun}…`}
        aria-label={`Filter ${itemNoun}`}
        className="w-full rounded-t-md border-zinc-700 border-b bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
      />
      <div className="max-h-60 overflow-y-auto py-1">
        {shown.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-zinc-500">{emptyReason}</p>
        ) : (
          shown.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onToggle(option)}
              aria-pressed={draft.includes(option)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-zinc-800"
            >
              <span className="w-3 text-xs text-indigo-400">
                {draft.includes(option) ? "✓" : ""}
              </span>
              {renderOption ? renderOption(option) : <span className="text-sm">{option}</span>}
            </button>
          ))
        )}
      </div>
      {truncated && (
        <p className="border-zinc-800 border-t px-2 py-1.5 text-xs text-amber-400">
          Showing the first 100 — this repo has more.
        </p>
      )}
      <div className="flex gap-2 border-zinc-800 border-t p-2">
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The issue detail view: title, labels, assignees, body, and comments, plus
 * editing (title, description, labels, assignees, open/closed state), comment
 * posting, and the "Start work" action that opens a workspace and launches a
 * Claude session seeded with the issue. Fetches full detail (body + comments)
 * on mount; the `summary` prop renders the header immediately while that loads.
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
  const [editingLabels, setEditingLabels] = useState(false);
  const [labelsDraft, setLabelsDraft] = useState<string[]>([]);
  const [editingAssignees, setEditingAssignees] = useState(false);
  const [assigneesDraft, setAssigneesDraft] = useState<string[]>([]);
  // The offered sets describe the repo, not the issue, so they are stored
  // against the repo they were fetched for: they then survive a move between two
  // issues in the same repo, and a move to a different one reads as "not loaded"
  // without any reset step that could leave the wrong repo's sets on screen.
  const [repoMetaFetch, setRepoMetaFetch] = useState<{
    sourceKey: string;
    data?: IssueRepoMeta;
    error?: string;
  } | null>(null);
  const forThisRepo = repoMetaFetch?.sourceKey === summary.sourceKey ? repoMetaFetch : null;
  const repoMeta = forThisRepo?.data ?? null;
  const repoMetaError = forThisRepo?.error ?? null;
  const [commentDraft, setCommentDraft] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [busyField, setBusyField] = useState(false);
  const startFlow = useGithubStartWork(onStarted);
  const starting = startFlow.startingKey !== null;
  const labelsRef = useDismissable(editingLabels, setEditingLabels);
  const assigneesRef = useDismissable(editingAssignees, setEditingAssignees);

  // Which issue is on screen, readable from an in-flight write's continuation.
  // A write started against the previous issue must not install its response as
  // the current one's detail.
  const shownKey = `${summary.provider}:${summary.sourceKey}#${summary.externalId}`;
  const shownKeyRef = useRef(shownKey);
  useEffect(() => {
    shownKeyRef.current = shownKey;
  }, [shownKey]);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    // The open editors belong to the issue leaving the screen. The field drafts
    // are re-seeded when their editor opens, so only the comment box — which has
    // no reopen step — needs clearing here.
    setEditingLabels(false);
    setEditingAssignees(false);
    setCommentDraft("");
    issueDetail(summary.sourceKey, summary.externalId, summary.provider)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(errMsg(e)));
    return () => {
      live = false;
    };
  }, [summary.sourceKey, summary.externalId, summary.provider]);

  // The repo's label and assignee sets only matter once a picker opens, so they
  // are fetched on first use rather than on every issue the user glances at.
  useEffect(() => {
    if (forThisRepo || (!editingLabels && !editingAssignees)) return;
    let live = true;
    const sourceKey = summary.sourceKey;
    issueRepoMeta(sourceKey, summary.provider)
      .then((data) => live && setRepoMetaFetch({ sourceKey, data }))
      // Recorded so the open picker can report it, rather than only the page
      // banner the popover covers — otherwise the list says "Loading…" forever
      // with no hint that it never will.
      .catch((e) => live && setRepoMetaFetch({ sourceKey, error: errMsg(e) }));
    return () => {
      live = false;
    };
  }, [editingLabels, editingAssignees, forThisRepo, summary.sourceKey, summary.provider]);

  const title = detail?.title ?? summary.title;
  const state = detail?.state ?? summary.state;

  /**
   * Runs a write against the issue on screen and adopts the fresh detail the
   * route returns — unless the user moved to another issue while it was in
   * flight, in which case the response describes an issue that is no longer
   * displayed and installing it would show one issue's data under another's.
   */
  const applyWrite = async (
    write: () => Promise<IssueDetail>,
    setBusy: (busy: boolean) => void,
    after?: () => void,
  ) => {
    const startedOn = shownKeyRef.current;
    setBusy(true);
    setError(null);
    try {
      const fresh = await write();
      if (shownKeyRef.current !== startedOn) return;
      setDetail(fresh);
      after?.();
      onChanged?.();
    } catch (e) {
      if (shownKeyRef.current === startedOn) setError(errMsg(e));
    } finally {
      // Always cleared: the busy flag belongs to this mounted view, not to the
      // issue the write was for, and leaving it set would freeze the controls.
      setBusy(false);
    }
  };

  /** Applies a partial edit and adopts the fresh detail the route returns. */
  const applyEdit = (input: IssueUpdateInput, after?: () => void) =>
    applyWrite(
      () => updateIssue(summary.sourceKey, summary.externalId, input, summary.provider),
      setBusyField,
      after,
    );

  const saveTitle = () => {
    if (!titleDraft.trim()) return;
    return applyEdit({ title: titleDraft.trim() }, () => setEditingTitle(false));
  };

  const saveBody = () => applyEdit({ body: bodyDraft }, () => setEditingBody(false));

  const toggleState = () => applyEdit({ state: state === "open" ? "closed" : "open" });

  const saveLabels = () => applyEdit({ labels: labelsDraft }, () => setEditingLabels(false));

  const saveAssignees = () =>
    applyEdit({ assignees: assigneesDraft }, () => setEditingAssignees(false));

  const postComment = () => {
    const body = commentDraft.trim();
    if (!body) return;
    return applyWrite(
      () => addIssueComment(summary.sourceKey, summary.externalId, body, summary.provider),
      setPostingComment,
      () => setCommentDraft(""),
    );
  };

  const labels = detail?.labels ?? summary.labels;
  const assignees = detail?.assignees ?? summary.assignees;

  /**
   * What a picker offers: what the repo has, plus whatever the issue already
   * carries. A label since deleted from the repo, or an assignee who lost
   * access, is still on this issue and so must still be listed — otherwise it
   * has no row to uncheck and Save puts it straight back.
   */
  const offered = (applied: string[], available: string[]) => [
    ...applied,
    ...available.filter((v) => !applied.includes(v)),
  ];

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
            <CopyLinkButton
              url={summary.url}
              subject="issue link"
              title={`Copy the GitHub link to ${summary.displayId}`}
            />
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
              // Gated on `detail` so the prompt is built from the body the user
              // has in front of them, not one fetched behind their back.
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

          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div ref={labelsRef} className="relative">
              <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
                Labels
                {detail && !editingLabels && (
                  <button
                    type="button"
                    onClick={() => {
                      setLabelsDraft(labels.map((l) => l.name));
                      setEditingLabels(true);
                    }}
                    className="normal-case text-zinc-600 hover:text-zinc-300"
                    title="Edit labels"
                  >
                    ✎
                  </button>
                )}
              </div>
              {labels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {labels.map((l) => (
                    <LabelPill key={l.name} name={l.name} color={l.color} />
                  ))}
                </div>
              ) : (
                <span className="text-sm text-zinc-600">No labels.</span>
              )}
              {editingLabels && (
                <SetPicker
                  itemNoun="labels"
                  options={offered(
                    labels.map((l) => l.name),
                    (repoMeta?.labels ?? []).map((l) => l.name),
                  )}
                  draft={labelsDraft}
                  onToggle={(name) => setLabelsDraft((d) => toggleIn(d, name))}
                  onSave={() => void saveLabels()}
                  onCancel={() => setEditingLabels(false)}
                  busy={busyField}
                  loading={!repoMeta && !repoMetaError}
                  loadError={repoMetaError}
                  truncated={repoMeta?.truncated.labels ?? false}
                  emptyText="No labels in this repo."
                  // The issue's own labels are searched too, so one the repo no
                  // longer offers still renders in its own colour.
                  renderOption={(name) => (
                    <LabelPill
                      name={name}
                      color={
                        [...(repoMeta?.labels ?? []), ...labels].find((l) => l.name === name)
                          ?.color ?? null
                      }
                    />
                  )}
                />
              )}
            </div>

            <div ref={assigneesRef} className="relative">
              <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
                Assignees
                {detail && !editingAssignees && (
                  <button
                    type="button"
                    onClick={() => {
                      setAssigneesDraft(assignees);
                      setEditingAssignees(true);
                    }}
                    className="normal-case text-zinc-600 hover:text-zinc-300"
                    title="Edit assignees"
                  >
                    ✎
                  </button>
                )}
              </div>
              <span className="text-sm text-zinc-300">
                {assignees.length > 0 ? (
                  assignees.join(", ")
                ) : (
                  <span className="text-zinc-600">Unassigned.</span>
                )}
              </span>
              {editingAssignees && (
                <SetPicker
                  itemNoun="assignees"
                  options={offered(assignees, repoMeta?.assignees ?? [])}
                  draft={assigneesDraft}
                  onToggle={(login) => setAssigneesDraft((d) => toggleIn(d, login))}
                  onSave={() => void saveAssignees()}
                  onCancel={() => setEditingAssignees(false)}
                  busy={busyField}
                  loading={!repoMeta && !repoMetaError}
                  loadError={repoMetaError}
                  truncated={repoMeta?.truncated.assignees ?? false}
                  emptyText="Nobody can be assigned in this repo."
                />
              )}
            </div>
          </div>

          {startFlow.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
              {startFlow.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          {/* Separate from the edit error: a stale failed edit must not hide the
              failure of the start the user just clicked. */}
          {startFlow.error && <p className="text-sm text-red-400">{startFlow.error}</p>}

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

          {detail && (
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
              <div className="mt-3 space-y-2">
                <textarea
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  placeholder="Add a comment…"
                  aria-label="Add a comment"
                  rows={3}
                  className={fieldInput}
                />
                <button
                  type="button"
                  onClick={() => void postComment()}
                  disabled={postingComment || !commentDraft.trim()}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  {postingComment ? "Posting…" : "Comment"}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
