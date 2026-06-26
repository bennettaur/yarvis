import { useEffect, useState } from "react";
import {
  type ChangedFile,
  type WorkspaceRepoDetail,
  workspaceRepoChanges,
  workspaceRepoFiles,
} from "../lib/workspaces";

type View = "files" | "changes" | "checks";

const VIEWS: { key: View; label: string }[] = [
  { key: "files", label: "All files" },
  { key: "changes", label: "Changed" },
  { key: "checks", label: "PR checks" },
];

/**
 * The workspace detail's right column: per-repo views of all tracked files,
 * changed files (with line counts), and the cached PR checks. Files/changes are
 * read live from the worktree; PR checks come from the background poller's cache.
 */
export default function WorkspaceSidePanel({
  workspaceId,
  repos,
}: {
  workspaceId: string;
  repos: WorkspaceRepoDetail[];
}) {
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [view, setView] = useState<View>("changes");

  const repo = repos.find((r) => r.id === repoId) ?? repos[0];
  if (!repo) return null;

  return (
    <div className="flex h-full min-h-0 w-80 shrink-0 flex-col border-l border-zinc-800">
      {repos.length > 1 && (
        <select
          value={repo.id}
          onChange={(e) => setRepoId(e.target.value)}
          className="m-2 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none"
        >
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.repo.name}
            </option>
          ))}
        </select>
      )}

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
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {view === "files" && <FilesView workspaceId={workspaceId} repoId={repo.id} />}
        {view === "changes" && <ChangesView workspaceId={workspaceId} repoId={repo.id} />}
        {view === "checks" && <ChecksView repo={repo} />}
      </div>
    </div>
  );
}

function FilesView({ workspaceId, repoId }: { workspaceId: string; repoId: string }) {
  const [data, setData] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    workspaceRepoFiles(workspaceId, repoId)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, repoId]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!data) return <p className="text-xs text-zinc-500">Loading…</p>;
  if (data.length === 0) return <p className="text-xs text-zinc-500">No files.</p>;
  return (
    <ul className="font-mono text-xs text-zinc-400">
      {data.map((path) => (
        <li key={path} className="truncate py-0.5" title={path}>
          {path}
        </li>
      ))}
    </ul>
  );
}

const CHANGE_COLORS: Record<string, string> = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  deleted: "text-red-400",
  renamed: "text-indigo-400",
  untracked: "text-zinc-500",
};

function ChangesView({ workspaceId, repoId }: { workspaceId: string; repoId: string }) {
  const [data, setData] = useState<ChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    workspaceRepoChanges(workspaceId, repoId)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, repoId]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!data) return <p className="text-xs text-zinc-500">Loading…</p>;
  if (data.length === 0) return <p className="text-xs text-zinc-500">No changes on this branch.</p>;
  return (
    <ul className="font-mono text-xs">
      {data.map((file) => (
        <li key={file.path} className="flex items-center gap-2 py-0.5">
          <span
            className={`shrink-0 ${CHANGE_COLORS[file.status] ?? "text-zinc-400"}`}
            title={file.status}
          >
            {file.status[0]?.toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-zinc-400" title={file.path}>
            {file.path}
          </span>
          {(file.additions > 0 || file.deletions > 0) && (
            <span className="shrink-0 text-zinc-500">
              <span className="text-emerald-400">+{file.additions}</span>{" "}
              <span className="text-red-400">−{file.deletions}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
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
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        {pr.prUrl ? (
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-indigo-400 hover:underline"
          >
            #{pr.prNumber}
          </a>
        ) : (
          <span>#{pr.prNumber}</span>
        )}
        {pr.prState && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{pr.prState}</span>
        )}
        {pr.isDraft && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">draft</span>
        )}
      </div>
      <div className={ROLLUP_COLOR[pr.checkRollup] ?? "text-zinc-400"}>
        {ROLLUP_LABEL[pr.checkRollup] ?? pr.checkRollup}
        {pr.checks && pr.checks.total > 0 && (
          <span className="text-zinc-500">
            {" "}
            ({pr.checks.success}/{pr.checks.total})
          </span>
        )}
      </div>
      {pr.mergeable && <div className="text-zinc-500">mergeable: {pr.mergeable}</div>}
      {pr.lastError && <div className="text-red-400">{pr.lastError}</div>}
    </div>
  );
}
