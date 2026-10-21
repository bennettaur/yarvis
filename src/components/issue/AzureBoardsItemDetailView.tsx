import { useEffect, useState } from "react";
import {
  boardsAddComment,
  boardsAssign,
  boardsItemDetail,
  boardsSetState,
  boardsUpdateFields,
} from "../../lib/azureBoards/api";
import type { BoardsWorkItemDetail } from "../../lib/azureBoards/types";
import { statesAsTransitions, useBoardsStartWork } from "../../lib/azureBoards/useBoardsStartWork";
import type { IssueSummary } from "../../lib/issues/types";
import { formatRelativeTime } from "../../lib/time";
import { openExternal } from "../../lib/url";
import CopyLinkButton from "../CopyLinkButton";
import LoadingIndicator from "../LoadingIndicator";
import Markdown from "../Markdown";
import JiraRepoPickerModal from "./JiraRepoPickerModal";
import { StatusBadge } from "./jiraStatus";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const fieldInput =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100";

/**
 * The Azure Boards work item view. Shows the item's fields, description and
 * comments, and lets the user edit the title, description, state and tags,
 * assign it to themselves or unassign it, comment, open it in Azure, and start
 * work on it.
 */
export default function AzureBoardsItemDetailView({
  summary,
  onBack,
  onStarted,
}: {
  summary: IssueSummary;
  onBack: () => void;
  onStarted?: () => void;
}) {
  const [detail, setDetail] = useState<BoardsWorkItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [editingTags, setEditingTags] = useState(false);
  const [tagsDraft, setTagsDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [savingComment, setSavingComment] = useState(false);
  const [busyField, setBusyField] = useState(false);

  const startFlow = useBoardsStartWork(onStarted);

  const id = summary.externalId;

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    boardsItemDetail(id)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(errMsg(e)));
    return () => {
      live = false;
    };
  }, [id]);

  const runField = async (fn: () => Promise<BoardsWorkItemDetail>, after?: () => void) => {
    setBusyField(true);
    setError(null);
    try {
      setDetail(await fn());
      after?.();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusyField(false);
    }
  };

  const saveTitle = () =>
    runField(
      () => boardsUpdateFields(id, { title: titleDraft.trim() }),
      () => setEditingTitle(false),
    );

  // Writes back to the field the text was read from: Repro Steps on a bug.
  const saveDescription = () =>
    runField(
      () => boardsUpdateFields(id, { [detail?.bodyField ?? "description"]: descDraft }),
      () => setEditingDesc(false),
    );

  // Azure tags may contain spaces, so they're separated by `;` or `,`.
  const saveTags = () => {
    const tags = tagsDraft
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean);
    return runField(
      () => boardsUpdateFields(id, { tags }),
      () => setEditingTags(false),
    );
  };

  const changeState = (state: string) => {
    if (!state) return;
    void runField(() => boardsSetState(id, state));
  };

  const addComment = async () => {
    if (!commentDraft.trim()) return;
    setSavingComment(true);
    setError(null);
    try {
      const comment = await boardsAddComment(id, commentDraft.trim());
      setCommentDraft("");
      setDetail(
        (d) => d && { ...d, comments: [...d.comments, comment], commentCount: d.commentCount + 1 },
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSavingComment(false);
    }
  };

  const title = detail?.title ?? summary.title;
  const labels = detail?.labels ?? summary.labels;
  const url = detail?.url ?? summary.url;

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
          {detail && <StatusBadge name={detail.statusName} category={detail.statusCategory} />}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => url && openExternal(url)}
              disabled={!url}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Open in Azure Boards ↗
            </button>
            {url && (
              <CopyLinkButton
                url={url}
                subject="work item link"
                title={`Copy the Azure Boards link to ${detail?.displayId ?? summary.displayId}`}
              />
            )}
            <button
              type="button"
              onClick={() => detail && startFlow.startWithDetail(detail)}
              disabled={startFlow.starting || !detail}
              className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {startFlow.starting ? "Starting…" : "Start work"}
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
                  aria-label="Title"
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
                {detail && (
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
                )}
              </div>
            )}
            {detail && (
              <p className="mt-1 text-xs text-zinc-500">
                {detail.issueType} · {detail.author} created this{" "}
                {formatRelativeTime(detail.createdAt)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm sm:grid-cols-4">
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">State</div>
              {detail && detail.states.length > 0 ? (
                <select
                  value=""
                  aria-label="Change state"
                  onChange={(e) => changeState(e.target.value)}
                  disabled={busyField}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-sm"
                >
                  <option value="">{detail.statusName}</option>
                  {detail.states
                    .filter((s) => s.name !== detail.statusName)
                    .map((s) => (
                      <option key={s.name} value={s.name}>
                        → {s.name}
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
                <div className="space-y-1">
                  <span className="block text-zinc-300">{detail.assignee ?? "Unassigned"}</span>
                  <div className="flex gap-2 text-xs">
                    <button
                      type="button"
                      disabled={busyField}
                      onClick={() => void runField(() => boardsAssign(id, true))}
                      className="text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
                    >
                      Assign to me
                    </button>
                    {detail.assignee && (
                      <button
                        type="button"
                        disabled={busyField}
                        onClick={() => void runField(() => boardsAssign(id, false))}
                        className="text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
                      >
                        Unassign
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <span className="text-zinc-500">…</span>
              )}
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Created by</div>
              <span className="text-zinc-300">{detail?.author ?? summary.author}</span>
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Priority</div>
              <span className="text-zinc-300">{detail?.priority ?? "—"}</span>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
              Tags
              {detail && !editingTags && (
                <button
                  type="button"
                  onClick={() => {
                    setTagsDraft(labels.map((l) => l.name).join("; "));
                    setEditingTags(true);
                  }}
                  className="normal-case text-zinc-600 hover:text-zinc-300"
                  title="Edit tags"
                >
                  ✎
                </button>
              )}
            </div>
            {editingTags ? (
              <div className="flex items-center gap-2">
                <input
                  value={tagsDraft}
                  aria-label="Tags"
                  onChange={(e) => setTagsDraft(e.target.value)}
                  placeholder="tags separated by ; or ,"
                  className={fieldInput}
                />
                <button
                  type="button"
                  onClick={() => void saveTags()}
                  disabled={busyField}
                  className="rounded-md bg-indigo-600 px-2 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busyField ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingTags(false)}
                  className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            ) : labels.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {labels.map((l) => (
                  <span
                    key={l.name}
                    className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300"
                  >
                    {l.name}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-sm text-zinc-600">No tags.</span>
            )}
          </div>

          {startFlow.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
              {startFlow.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          {!startFlow.pending && startFlow.error && (
            <p className="text-sm text-red-400">{startFlow.error}</p>
          )}

          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                {detail?.bodyField === "reproSteps" ? "Repro steps" : "Description"}
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
              !error && <LoadingIndicator />
            ) : editingDesc ? (
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">
                  Saved as plain text, so formatting from Azure is replaced.
                </p>
                <textarea
                  value={descDraft}
                  aria-label="Description"
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
                aria-label="New comment"
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Add a comment…"
                rows={3}
                className={fieldInput}
              />
              <button
                type="button"
                onClick={() => void addComment()}
                disabled={savingComment || !commentDraft.trim() || !detail}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
              >
                {savingComment ? "Posting…" : "Comment"}
              </button>
            </div>
          </section>
        </div>
      </div>

      {startFlow.pending && (
        <JiraRepoPickerModal
          projectKey={`azure:${startFlow.pending.sourceKey}`}
          issueKey={startFlow.pending.displayId}
          transitions={statesAsTransitions(startFlow.pending)}
          busy={startFlow.starting}
          startError={startFlow.error}
          onConfirm={(choice) => void startFlow.confirm(choice)}
          onClose={startFlow.cancel}
        />
      )}
    </div>
  );
}
