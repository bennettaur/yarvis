import { useCallback, useEffect, useMemo, useState } from "react";
import { clipboardSafePath, clipboardSafeText, clipboardSafeUrl } from "../lib/clipboard";
import { buildFileTree } from "../lib/fileTree";
import { requestOpenPr } from "../lib/nav";
import type { PrSummary } from "../lib/pr/types";
import { repoPrRef } from "../lib/repos";
import { openExternal } from "../lib/url";
import { isResolved, useReviewComments } from "../lib/workspaceReview";
import {
  type ChangedFile,
  listWorkspaceWorktrees,
  type WorkspaceRepoDetail,
  type WorkspaceRepoWorktrees,
  type WorkspaceWorktree,
  workspaceRepoChanges,
  workspaceRepoFiles,
  worktreePr,
} from "../lib/workspaces";
import CopyButton from "./CopyButton";
import CopyLinkButton from "./CopyLinkButton";
import FileTreeRows, { treeRowPaddingLeft } from "./files/FileTreeRows";
import CopyPathButton from "./pr/CopyPathButton";
import type { OpenFileDiff } from "./shell/terminalTabs/TerminalTabs";
import WorkspaceReviewComments from "./workspaces/WorkspaceReviewComments";
import WorkspaceStackView from "./workspaces/WorkspaceStackView";

type View = "files" | "changes" | "comments" | "checks" | "stack";

const VIEWS: { key: View; label: string }[] = [
  { key: "files", label: "All files" },
  { key: "changes", label: "Changed" },
  { key: "comments", label: "Comments" },
  { key: "checks", label: "PR checks" },
  { key: "stack", label: "Stack" },
];

/** Which repo, and which of its worktrees, the column is showing. A null
 *  worktree is the primary one. */
interface Selection {
  repoId: string;
  worktree: string | null;
}

/** A picker option's value. JSON rather than a joined string, since a path can
 *  hold any separator a join would use. */
const optionValue = (repoId: string, worktree: WorkspaceWorktree): string =>
  JSON.stringify([repoId, worktree.primary ? null : worktree.path]);

const worktreeLabel = (worktree: WorkspaceWorktree): string => worktree.branch ?? "detached HEAD";

/**
 * The workspace detail's right column: per-repo views of all tracked files,
 * changed files (with line counts), the PR checks, and the stack of pull
 * requests the branch belongs to, plus the self-review comments left on the
 * diffs. Files/changes are read live from the worktree; the primary branch's PR
 * checks come from the background poller's cache; the stack is read on demand,
 * since it costs a provider call per layer. The comments view spans the whole
 * workspace rather than the selected repo — a review is read as one list, and
 * each entry names the repo it belongs to.
 *
 * Every per-repo view can be pointed at any of the repo's worktrees inside the
 * workspace folder, not only the one provisioning cut: an agent building a
 * stack usually gives each layer a worktree of its own, and the branch the
 * workspace started on need not be one of them.
 */
export default function WorkspaceSidePanel({
  workspaceId,
  repos,
  onOpenFile,
  onEditFile,
}: {
  workspaceId: string;
  repos: WorkspaceRepoDetail[];
  /** Open a changed file's diff in a tab. */
  onOpenFile: (file: OpenFileDiff) => void;
  /** Open a file in an editor tab. */
  onEditFile: (file: OpenFileDiff) => void;
}) {
  const [selection, setSelection] = useState<Selection>({
    repoId: repos[0]?.id ?? "",
    worktree: null,
  });
  const [view, setView] = useState<View>("changes");
  // Read here as well as inside the comments view so the tab can carry the open
  // count — the reason to switch to it is knowing there is something in it.
  const { comments } = useReviewComments(workspaceId);
  const openComments = comments.filter((c) => !isResolved(c)).length;

  const loadWorktrees = useCallback(() => listWorkspaceWorktrees(workspaceId), [workspaceId]);
  const { data: discovered } = usePolled(loadWorktrees, sameWorktrees);
  // A repo the listing hasn't answered for — not ready yet, or still loading —
  // offers its primary worktree alone.
  const worktreesFor = (r: WorkspaceRepoDetail): WorkspaceWorktree[] =>
    discovered?.find((d) => d.workspaceRepoId === r.id)?.worktrees ?? [
      { path: r.worktreePath, branch: r.branch, primary: true },
    ];

  const repo = repos.find((r) => r.id === selection.repoId) ?? repos[0];
  if (!repo) return null;
  const repoWorktrees = worktreesFor(repo);
  // A worktree removed since it was picked falls back to the primary one.
  const worktree =
    repoWorktrees.find((w) => (selection.worktree ? w.path === selection.worktree : w.primary)) ??
    repoWorktrees[0]!;
  const worktreePath = worktree.primary ? undefined : worktree.path;
  const optionCount = repos.reduce((n, r) => n + worktreesFor(r).length, 0);

  const openTarget = (path: string): OpenFileDiff => ({
    repoId: repo.id,
    path,
    ...(worktreePath ? { worktree: worktreePath, worktreeLabel: worktreeLabel(worktree) } : {}),
  });

  const options = (r: WorkspaceRepoDetail) =>
    worktreesFor(r).map((w) => (
      <option key={w.path} value={optionValue(r.id, w)}>
        {worktreeLabel(w)}
        {w.primary ? " (workspace branch)" : ""}
      </option>
    ));

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {optionCount > 1 && (
        <select
          aria-label="Repo and worktree to show"
          value={optionValue(repo.id, worktree)}
          onChange={(e) => {
            const [repoId, path] = JSON.parse(e.target.value) as [string, string | null];
            setSelection({ repoId, worktree: path });
          }}
          className="mx-2 mt-2 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none"
        >
          {repos.length > 1
            ? repos.map((r) => (
                <optgroup key={r.id} label={r.repo.name}>
                  {options(r)}
                </optgroup>
              ))
            : options(repo)}
        </select>
      )}
      <div className="flex shrink-0 items-center gap-1 px-3 pt-1.5 text-xs text-zinc-500">
        {/* The trailing space keeps these two words apart for a screen reader. */}
        <span className="shrink-0">Viewing </span>
        <span className="min-w-0 truncate font-mono text-zinc-300" title={worktree.path}>
          {repos.length > 1 ? `${repo.repo.name} · ` : ""}
          {worktreeLabel(worktree)}
        </span>
        {!worktree.primary && <CopyPathButton path={worktree.path} />}
      </div>

      <div className="flex shrink-0 gap-1 border-b border-zinc-800 px-2 pt-1">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`border-b-2 px-2 py-1.5 text-xs ${
              view === v.key
                ? "border-indigo-400 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {v.label}
            {v.key === "comments" && openComments > 0 && (
              <span className="ml-1 rounded bg-zinc-800 px-1 text-zinc-300">{openComments}</span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {view === "files" && (
          <FilesView
            workspaceId={workspaceId}
            repoId={repo.id}
            worktree={worktreePath}
            onEditFile={(path) => onEditFile(openTarget(path))}
          />
        )}
        {view === "changes" && (
          <ChangesView
            workspaceId={workspaceId}
            repoId={repo.id}
            worktree={worktreePath}
            onOpenFile={(path) => onOpenFile(openTarget(path))}
            onEditFile={(path) => onEditFile(openTarget(path))}
          />
        )}
        {view === "comments" && (
          <WorkspaceReviewComments
            workspaceId={workspaceId}
            repos={repos}
            onOpenFile={(repoId, path) => onOpenFile({ repoId, path })}
          />
        )}
        {view === "checks" &&
          (worktreePath ? (
            <WorktreeChecksView
              workspaceId={workspaceId}
              repo={repo}
              worktree={worktreePath}
              branch={worktree.branch}
            />
          ) : (
            <ChecksView repo={repo} />
          ))}
        {view === "stack" && (
          <WorkspaceStackView
            workspaceId={workspaceId}
            repo={repo}
            worktree={worktreePath}
            branch={worktree.branch}
            worktrees={repoWorktrees}
            onViewWorktree={(w) =>
              setSelection({ repoId: repo.id, worktree: w.primary ? null : w.path })
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * How often the files / changes views refresh while the workspace is visible.
 * Picked to feel live without hammering git on every keystroke; the call is
 * already cheap (a single git command per repo).
 */
const REFRESH_INTERVAL_MS = 5_000;

/**
 * Subscribes to a worktree-derived list (files, changes, or the worktrees
 * themselves) and refreshes it on a fixed interval. Skips polling while the
 * tab/window is hidden so a backgrounded app doesn't keep firing git commands;
 * resumes on visibility. `load` is memoized by the caller on everything it
 * reads, so a change of repo or worktree starts a fresh poll. `same` lets the
 * caller skip a re-render when the freshly-fetched data is deep-equal to what's
 * already shown, which keeps the list from flickering and holds the array's
 * identity steady so a view can memoize off it.
 */
function usePolled<T>(
  load: () => Promise<T>,
  same: (prev: T | null, next: T) => boolean,
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const next = await load();
        if (!live) return;
        setError(null);
        setData((prev) => (prev !== null && same(prev, next) ? prev : next));
      } catch (e) {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (live && !document.hidden) {
          timer = setTimeout(tick, REFRESH_INTERVAL_MS);
        }
      }
    };

    const onVisibility = () => {
      if (!document.hidden && live && timer === null) {
        void tick();
      }
    };

    setData(null);
    setError(null);
    void tick();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, same]);

  return { data, error };
}

const sameStringArray = (prev: string[] | null, next: string[]): boolean => {
  if (prev === null || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
};

const sameWorktrees = (
  prev: WorkspaceRepoWorktrees[] | null,
  next: WorkspaceRepoWorktrees[],
): boolean => prev !== null && JSON.stringify(prev) === JSON.stringify(next);

const sameChangedFiles = (prev: ChangedFile[] | null, next: ChangedFile[]): boolean => {
  if (prev === null || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (
      a.path !== b.path ||
      a.status !== b.status ||
      a.additions !== b.additions ||
      a.deletions !== b.deletions
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Row above a file list: how many files it holds, and a copy of the whole list
 * — the form these lists get pasted in, one path per line, sanitized the same
 * way a single path is.
 */
function FileListHeader({ paths, noun }: { paths: string[]; noun: string }) {
  return (
    <div className="mb-1 flex items-center gap-1 px-2 text-xs text-zinc-500">
      <span>
        {paths.length} {noun}
        {paths.length === 1 ? "" : "s"}
      </span>
      <CopyButton
        value={() => paths.map(clipboardSafePath).join("\n")}
        subject="file list"
        title="Copy every path in this list"
      />
    </div>
  );
}

function FilesView({
  workspaceId,
  repoId,
  worktree,
  onEditFile,
}: {
  workspaceId: string;
  repoId: string;
  worktree: string | undefined;
  onEditFile: (path: string) => void;
}) {
  const load = useCallback(
    () => workspaceRepoFiles(workspaceId, repoId, worktree),
    [workspaceId, repoId, worktree],
  );
  const { data, error } = usePolled(load, sameStringArray);

  // Hoisted above the early returns to keep hook order stable. Memoized because
  // this list is the whole worktree and the poll re-runs every few seconds.
  const tree = useMemo(() => (data ? buildFileTree(data, (path) => path) : []), [data]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!data) return <p className="text-xs text-zinc-500">Loading…</p>;
  if (data.length === 0) return <p className="text-xs text-zinc-500">No files.</p>;
  return (
    <>
      <FileListHeader paths={data} noun="file" />
      <ul className="space-y-0.5 font-mono text-xs text-zinc-400">
        <FileTreeRows
          nodes={tree}
          defaultOpen={false}
          renderFile={(node, depth) => (
            <div
              className="group/row flex items-center gap-2 rounded hover:bg-zinc-800/60"
              style={{ paddingLeft: treeRowPaddingLeft(depth) }}
            >
              <button
                type="button"
                onClick={() => onEditFile(node.path)}
                title={`Edit ${node.path}`}
                className="min-w-0 flex-1 truncate px-2 py-0.5 text-left"
              >
                {node.name}
              </button>
              <CopyPathButton
                path={node.path}
                className="mr-2 opacity-0 transition-opacity focus:opacity-100 group-hover/row:opacity-100"
              />
            </div>
          )}
        />
      </ul>
    </>
  );
}

const CHANGE_COLORS: Record<string, string> = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  deleted: "text-red-400",
  renamed: "text-indigo-400",
  untracked: "text-zinc-500",
};

function ChangesView({
  workspaceId,
  repoId,
  worktree,
  onOpenFile,
  onEditFile,
}: {
  workspaceId: string;
  repoId: string;
  worktree: string | undefined;
  onOpenFile: (path: string) => void;
  onEditFile: (path: string) => void;
}) {
  const load = useCallback(
    () => workspaceRepoChanges(workspaceId, repoId, worktree),
    [workspaceId, repoId, worktree],
  );
  const { data, error } = usePolled(load, sameChangedFiles);

  // Hoisted above the early returns to keep hook order stable.
  const tree = useMemo(() => (data ? buildFileTree(data, (file) => file.path) : []), [data]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!data) return <p className="text-xs text-zinc-500">Loading…</p>;
  if (data.length === 0) return <p className="text-xs text-zinc-500">No changes on this branch.</p>;
  return (
    <>
      <FileListHeader paths={data.map((f) => f.path)} noun="changed file" />
      <ul className="space-y-0.5 font-mono text-xs">
        <FileTreeRows
          nodes={tree}
          renderFile={(node, depth) => {
            const file = node.file;
            return (
              <div
                className="group/row flex w-full items-center gap-2 rounded px-2 py-0.5 hover:bg-zinc-800/60"
                style={{ paddingLeft: treeRowPaddingLeft(depth) }}
              >
                <button
                  type="button"
                  onClick={() => onOpenFile(file.path)}
                  title={`Open diff for ${file.path}`}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span
                    className={`shrink-0 ${CHANGE_COLORS[file.status] ?? "text-zinc-400"}`}
                    title={file.status}
                  >
                    {file.status[0]?.toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-zinc-400">{node.name}</span>
                  {(file.additions > 0 || file.deletions > 0) && (
                    <span className="shrink-0 text-zinc-500">
                      <span className="text-emerald-400">+{file.additions}</span>{" "}
                      <span className="text-red-400">−{file.deletions}</span>
                    </span>
                  )}
                </button>
                {/* Kept beside the diff rather than replacing it: the reason to
                    open a changed file is usually to read what changed. A
                    deleted file has nothing to open. */}
                {file.status !== "deleted" && (
                  <button
                    type="button"
                    onClick={() => onEditFile(file.path)}
                    title={`Edit ${file.path}`}
                    aria-label={`Edit ${file.path}`}
                    className="shrink-0 text-zinc-600 opacity-0 transition-opacity hover:text-zinc-200 focus:opacity-100 group-hover/row:opacity-100"
                  >
                    ✎
                  </button>
                )}
                <CopyPathButton
                  path={file.path}
                  className="opacity-0 transition-opacity focus:opacity-100 group-hover/row:opacity-100"
                />
              </div>
            );
          }}
        />
      </ul>
    </>
  );
}

const ROLLUP_LABEL: Record<string, string> = {
  success: "✓ checks passing",
  failure: "✗ checks failing",
  pending: "● checks running",
  none: "no checks",
};
const ROLLUP_COLOR: Record<string, string> = {
  success: "text-emerald-400",
  failure: "text-red-400",
  pending: "text-amber-400",
  none: "text-zinc-500",
};

/**
 * Single-line "3 passing · 1 failing · 2 running" summary so the user sees
 * every bucket even when one wins the rollup. Buckets with zero are omitted.
 */
function describeChecks(checks: {
  total: number;
  success: number;
  failure: number;
  pending: number;
}): string {
  const parts: string[] = [];
  if (checks.success) parts.push(`${checks.success} passing`);
  if (checks.failure) parts.push(`${checks.failure} failing`);
  if (checks.pending) parts.push(`${checks.pending} running`);
  return parts.join(" · ");
}

/**
 * Builds a minimal PrSummary from the workspace poller's cache. Fields the
 * poller doesn't store (title, author, timestamps) are filled with placeholders
 * — PrDetailView refetches the full detail anyway, so the only visible gap is
 * a brief blank title while the detail loads. The ref's provider comes from the
 * repo's clone URL, so an Azure PR opens as an Azure ref.
 */
function buildPrSummary(repo: WorkspaceRepoDetail): PrSummary | null {
  const pr = repo.pr;
  if (!pr?.prNumber || !pr.prUrl) return null;
  return {
    ref: repoPrRef(repo.repo, pr.prNumber),
    title: "",
    url: pr.prUrl,
    author: "",
    draft: pr.isDraft ?? false,
    state: pr.prState ?? "open",
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * The checks view as pasteable text: the PR, where its checks stand and its
 * link, which is what gets handed to someone in chat when CI goes red.
 */
function checksClipboardText(repoName: string, pr: NonNullable<WorkspaceRepoDetail["pr"]>): string {
  const rollup = ROLLUP_LABEL[pr.checkRollup] ?? pr.checkRollup;
  const counts = pr.checks && pr.checks.total > 0 ? describeChecks(pr.checks) : "";
  const headline = [`${clipboardSafeText(repoName)} #${pr.prNumber}`, rollup, counts]
    .filter(Boolean)
    .join(" · ");
  return [headline, clipboardSafeUrl(pr.prUrl)].filter(Boolean).join("\n");
}

function ChecksView({ repo }: { repo: WorkspaceRepoDetail }) {
  const pr = repo.pr;
  if (!pr || pr.lastPolledAt === null) {
    return <p className="text-xs text-zinc-500">Not polled yet.</p>;
  }
  if (pr.prNumber === null) {
    return (
      <p className="text-xs text-zinc-500">
        No PR for <span className="font-mono">{repo.branch}</span> yet.
        {pr.lastError && <span className="block text-red-400">{pr.lastError}</span>}
      </p>
    );
  }
  const summary = buildPrSummary(repo);
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-mono">#{pr.prNumber}</span>
        <CopyButton
          value={() => checksClipboardText(repo.repo.name, pr)}
          subject="check summary"
          title="Copy the check summary and the PR link"
        />
        {pr.prState && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{pr.prState}</span>
        )}
        {pr.isDraft && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">draft</span>
        )}
      </div>
      <div className="flex gap-1.5">
        {summary && (
          <button
            type="button"
            onClick={() => requestOpenPr(summary)}
            className="rounded-md border border-indigo-700/60 bg-indigo-900/30 px-2 py-1 text-xs text-indigo-200 hover:bg-indigo-900/60"
          >
            Review in yarvis
          </button>
        )}
        {pr.prUrl && (
          <>
            <button
              type="button"
              onClick={() => openExternal(pr.prUrl as string)}
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Open externally ↗
            </button>
            <CopyLinkButton
              url={pr.prUrl}
              subject="PR link"
              title={`Copy the link to ${repo.repo.name} #${pr.prNumber}`}
            />
          </>
        )}
      </div>
      <div className={ROLLUP_COLOR[pr.checkRollup] ?? "text-zinc-400"}>
        {ROLLUP_LABEL[pr.checkRollup] ?? pr.checkRollup}
      </div>
      {pr.checks && pr.checks.total > 0 && (
        <div className="text-zinc-500">{describeChecks(pr.checks)}</div>
      )}
      {pr.mergeable && <div className="text-zinc-500">mergeable: {pr.mergeable}</div>}
      {pr.lastError && <div className="text-red-400">{pr.lastError}</div>}
    </div>
  );
}

/**
 * The checks view for one of a repo's other worktrees. The poller only caches
 * the primary branch's PR, so this one is read from the provider when the view
 * opens — on demand rather than polled, since each read is a rate-limited API
 * call — and handed to the same view the cached row renders through.
 */
function WorktreeChecksView({
  workspaceId,
  repo,
  worktree,
  branch,
}: {
  workspaceId: string;
  repo: WorkspaceRepoDetail;
  worktree: string;
  branch: string | null;
}) {
  const [loaded, setLoaded] = useState<{ pr: WorkspaceRepoDetail["pr"] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await worktreePr(workspaceId, repo.id, worktree);
      setLoaded({
        pr: result.pr && { ...result.pr, lastPolledAt: new Date().toISOString(), lastError: null },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, repo.id, worktree]);

  useEffect(() => {
    setLoaded(null);
    void load();
  }, [load]);

  if (!branch) {
    return <p className="text-xs text-zinc-500">This worktree is on a detached HEAD.</p>;
  }
  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!loaded) return <p className="text-xs text-zinc-500">Loading…</p>;
  if (!loaded.pr) {
    return (
      <p className="text-xs text-zinc-500">No provider is configured that can look up this PR.</p>
    );
  }
  return (
    <div className="space-y-2">
      <ChecksView repo={{ ...repo, branch, pr: loaded.pr }} />
      <button
        type="button"
        onClick={() => void load()}
        disabled={loading}
        className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
