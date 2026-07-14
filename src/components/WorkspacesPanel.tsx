import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeIssuePromptFile } from "../lib/issues/api";
import type { OpenWorkspaceRequest } from "../lib/nav";
import { getClaudeCommand, ptyExists, startClaudeSession } from "../lib/pty";
import { createRepo, listRepoBranches, listRepos, type Repo } from "../lib/repos";
import { listTasks, type Task } from "../lib/tasks";
import { openExternal } from "../lib/url";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  unlinkWorkspaceIssue,
  unlinkWorkspaceTask,
  type WorkspaceDetail,
  type WorkspaceRepoDetail,
  type WorkspaceRepoStatus,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "../lib/workspaces";
import SplitPane, { usePersistedRatio } from "./SplitPane";
import TerminalTabs, {
  type OpenFileDiff,
  type OpenSetupLog,
} from "./shell/terminalTabs/TerminalTabs";
import TerminalPanel from "./TerminalPanel";
import WorkspaceSidePanel from "./WorkspaceSidePanel";
import ArchiveDialog from "./workspaces/ArchiveDialog";
import ArchivedView from "./workspaces/ArchivedView";
import { DEFAULT_CLAUDE_COMMAND, resolveClaudeTab } from "./workspaces/claudeTab";
import LinkWorkModal from "./workspaces/LinkWorkModal";
import { consumeProvision } from "./workspaces/provisionStream";
import WorkspaceFileDiff from "./workspaces/WorkspaceFileDiff";
import WorkspacePrStatus from "./workspaces/WorkspacePrStatus";
import WorkspaceSetupLog from "./workspaces/WorkspaceSetupLog";

const STATUS_STYLES: Record<WorkspaceStatus, string> = {
  creating: "bg-amber-900/40 text-amber-200",
  active: "bg-emerald-900/40 text-emerald-200",
  archiving: "bg-amber-900/40 text-amber-200",
  archived: "bg-zinc-800 text-zinc-400",
  error: "bg-red-900/40 text-red-200",
};

function StatusBadge({ status }: { status: WorkspaceStatus }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLES[status]}`}>{status}</span>;
}

const REPO_STATUS_STYLES: Record<WorkspaceRepoStatus, string> = {
  pending: "bg-zinc-800 text-zinc-400",
  provisioning: "bg-amber-900/40 text-amber-200",
  ready: "bg-emerald-900/40 text-emerald-200",
  removed: "bg-zinc-800 text-zinc-400",
  error: "bg-red-900/40 text-red-200",
};

function RepoStatusBadge({ status }: { status: WorkspaceRepoStatus }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${REPO_STATUS_STYLES[status]}`}>{status}</span>
  );
}

interface Group {
  key: string;
  label: string;
  items: WorkspaceSummary[];
}

/**
 * Groups single-repo workspaces under their repo's name; multi-repo workspaces
 * each form their own group, labeled by their repo set.
 */
function groupWorkspaces(items: WorkspaceSummary[]): Group[] {
  const singleByRepo = new Map<string, WorkspaceSummary[]>();
  const multi: Group[] = [];
  for (const ws of items) {
    if (ws.repoNames.length <= 1) {
      const repo = ws.repoNames[0] ?? "Scratch";
      const arr = singleByRepo.get(repo) ?? [];
      arr.push(ws);
      singleByRepo.set(repo, arr);
    } else {
      multi.push({ key: `ws:${ws.id}`, label: ws.repoNames.join(" + "), items: [ws] });
    }
  }
  const single = [...singleByRepo.entries()]
    .map(([repo, ws]) => ({ key: `repo:${repo}`, label: repo, items: ws }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...single, ...multi];
}

const SELECTED_WORKSPACE_KEY = "yarvis.workspaces.selectedId";
const SHOW_ARCHIVED_KEY = "yarvis.workspaces.showArchived";

/** Where a workspace's Claude session runs: always the workspace root, so Claude
 *  sees each repo's worktree as a subfolder and can read the
 *  `.yarvis/issue-prompt.md` seeded there for an issue "Start work" session. */
function claudeCwdForWorkspace(detail: WorkspaceDetail): string {
  return detail.rootPath;
}

export default function WorkspacesPanel({
  requested = null,
  onRequestConsumed,
}: {
  /** A workspace another tab asked us to open, optionally with a Claude prompt. */
  requested?: OpenWorkspaceRequest | null;
  /** Called once we've consumed `requested` so the parent can clear it. */
  onRequestConsumed?: () => void;
} = {}) {
  const [items, setItems] = useState<WorkspaceSummary[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_WORKSPACE_KEY),
  );
  // A pending "Start work" Claude launch, scoped to one workspace id. Cleared
  // when the user navigates to a different workspace so the prompt never leaks.
  const [claudeRequest, setClaudeRequest] = useState<{ id: string; prompt: string } | null>(null);
  // The workspace just created in this session. The detail view auto-starts a
  // Claude session for it once provisioned; cleared when the user navigates
  // elsewhere so selecting an existing workspace never auto-launches Claude.
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState<boolean>(
    () => localStorage.getItem(SHOW_ARCHIVED_KEY) === "1",
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [ws, rs] = await Promise.all([listWorkspaces(), listRepos()]);
      setItems(ws);
      setRepos(rs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Persisted across reloads.
  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_WORKSPACE_KEY, selectedId);
    else localStorage.removeItem(SELECTED_WORKSPACE_KEY);
  }, [selectedId]);

  // Honor a cross-tab open request (Issues "Start work"): select the workspace
  // and, if a Claude prompt came with it, stash it for the detail view to
  // launch once provisioning finishes. Cleared via the consumed callback.
  useEffect(() => {
    if (!requested) return;
    setCreating(false);
    setSelectedId(requested.id);
    setJustCreatedId(null);
    setClaudeRequest(
      requested.claudePrompt ? { id: requested.id, prompt: requested.claudePrompt } : null,
    );
    onRequestConsumed?.();
  }, [requested, onRequestConsumed]);

  useEffect(() => {
    if (showArchived) localStorage.setItem(SHOW_ARCHIVED_KEY, "1");
    else localStorage.removeItem(SHOW_ARCHIVED_KEY);
  }, [showArchived]);

  // If the remembered workspace has since been removed (or doesn't exist for
  // this user yet), drop the selection so the empty state shows.
  useEffect(() => {
    if (!selectedId || items.length === 0) return;
    if (!items.some((w) => w.id === selectedId)) setSelectedId(null);
  }, [items, selectedId]);

  const visibleItems = useMemo(
    () => (showArchived ? items : items.filter((w) => w.status !== "archived")),
    [items, showArchived],
  );
  const archivedCount = useMemo(() => items.filter((w) => w.status === "archived").length, [items]);

  const groups = useMemo(() => groupWorkspaces(visibleItems), [visibleItems]);

  const beginNew = () => {
    setCreating(true);
    setSelectedId(null);
    setJustCreatedId(null);
    setClaudeRequest(null);
  };

  const onCreated = (id: string) => {
    setCreating(false);
    void refresh();
    setSelectedId(id);
    // Marks this workspace for the detail view's one-shot Claude auto-start.
    setJustCreatedId(id);
  };

  const onRepoAdded = useCallback((repo: Repo) => {
    setRepos((prev) => (prev.some((r) => r.id === repo.id) ? prev : [...prev, repo]));
  }, []);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
        <div className="flex shrink-0 items-center justify-between px-3 py-2">
          <h2 className="text-sm font-medium text-zinc-200">Workspaces</h2>
          <button
            type="button"
            onClick={beginNew}
            className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium hover:bg-indigo-500"
          >
            New
          </button>
        </div>
        {error && <p className="px-3 pb-2 text-xs text-red-400">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {groups.length === 0 && (
            <p className="px-1 py-2 text-xs text-zinc-500">
              {showArchived || archivedCount === 0 ? "No workspaces yet." : "No active workspaces."}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.key} className="mb-3">
              <div className="px-1 py-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                {group.label}
              </div>
              <ul>
                {group.items.map((ws) => (
                  <li key={ws.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setCreating(false);
                        setSelectedId(ws.id);
                        setJustCreatedId(null);
                        setClaudeRequest(null);
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-800/60 ${
                        selectedId === ws.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-300"
                      }`}
                    >
                      <span className="truncate">{ws.name}</span>
                      <StatusBadge status={ws.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {archivedCount > 0 && (
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-zinc-500 hover:bg-zinc-800/40 hover:text-zinc-300"
            >
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </button>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {creating ? (
          <NewWorkspaceForm
            repos={repos}
            onCancel={() => setCreating(false)}
            onCreated={onCreated}
            onRepoAdded={onRepoAdded}
          />
        ) : selectedId ? (
          <WorkspaceDetailView
            key={selectedId}
            id={selectedId}
            onChanged={refresh}
            claudePrompt={claudeRequest?.id === selectedId ? claudeRequest.prompt : undefined}
            autoStartClaude={justCreatedId === selectedId}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Select a workspace or create a new one.
          </div>
        )}
      </main>
    </div>
  );
}

function NewWorkspaceForm({
  repos,
  onCancel,
  onCreated,
  onRepoAdded,
}: {
  repos: Repo[];
  onCancel: () => void;
  onCreated: (id: string) => void;
  onRepoAdded: (repo: Repo) => void;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // repo id -> chosen existing branch ("" means cut a fresh branch).
  const [selectedBranchByRepo, setSelectedBranchByRepo] = useState<Record<string, string>>({});
  // repo id -> its fetched remote branches, or a loading/error sentinel.
  const [remoteBranchesByRepo, setRemoteBranchesByRepo] = useState<
    Record<string, string[] | "loading" | "error">
  >({});
  const [taskId, setTaskId] = useState("");
  const [openTasks, setOpenTasks] = useState<Task[]>([]);
  const [phase, setPhase] = useState<"form" | "provisioning">("form");
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    listTasks({ status: "open" })
      .then(setOpenTasks)
      .catch(() => setOpenTasks([]));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each append
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  // Fetch a repo's remote branches once, when it's first selected, so the
  // existing-branch dropdown can be populated without an upfront fetch per repo.
  const loadBranches = (id: string) => {
    setRemoteBranchesByRepo((prev) => (prev[id] ? prev : { ...prev, [id]: "loading" }));
    listRepoBranches(id)
      .then((branches) => setRemoteBranchesByRepo((prev) => ({ ...prev, [id]: branches })))
      .catch(() => setRemoteBranchesByRepo((prev) => ({ ...prev, [id]: "error" })));
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        if (!remoteBranchesByRepo[id]) loadBranches(id);
      }
      return next;
    });
  };

  const submit = async () => {
    if (!name.trim()) {
      setError("Pick a name.");
      return;
    }
    // Only send branch choices for still-selected repos, dropping the "new
    // branch" default so the map carries just the existing-branch picks.
    const existingBranches: Record<string, string> = {};
    for (const id of selected) {
      if (selectedBranchByRepo[id]) existingBranches[id] = selectedBranchByRepo[id]!;
    }
    try {
      const ws = await createWorkspace({
        name: name.trim(),
        repoIds: [...selected],
        existingBranches: Object.keys(existingBranches).length ? existingBranches : undefined,
        taskId: taskId || undefined,
      });
      setPhase("provisioning");
      const result = await consumeProvision(ws.id, (text) => setLog((prev) => prev + text));
      // A hard top-level error (workspace not found, already provisioning) has no
      // useful detail view, so stay on the log screen. Otherwise — success or a
      // repo whose setup failed — open the workspace: its detail view auto-opens
      // the failed repo's setup-log tab.
      if (result.error) setError(result.error);
      else onCreated(ws.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (phase === "provisioning") {
    return (
      <div className="flex h-full min-h-0 flex-col p-6">
        <h2 className="mb-3 text-sm font-medium text-zinc-200">Provisioning “{name}”…</h2>
        {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
        <pre
          ref={logRef}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-[#09090b] p-3 font-mono text-xs text-zinc-300"
        >
          {log || "Starting…"}
        </pre>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-lg space-y-5">
        <h2 className="text-sm font-medium text-zinc-200">New workspace</h2>
        {error && <p className="text-sm text-red-400">{error}</p>}

        <label className="block text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Name</span>
          <input
            value={name}
            placeholder="rename the API"
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
        </label>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Repos <span className="normal-case text-zinc-600">(optional)</span>
            </div>
            <button
              type="button"
              onClick={() => setShowAddRepo((v) => !v)}
              className="text-xs text-indigo-400 hover:text-indigo-300"
            >
              {showAddRepo ? "Cancel" : "+ Add new"}
            </button>
          </div>
          <p className="mb-1 text-xs text-zinc-500">
            Leave empty for a scratch workspace — just a folder to run Claude in, for
            experimentation and exploration.
          </p>
          {repos.length === 0 && !showAddRepo && (
            <p className="text-xs text-zinc-500">
              No repos registered. Click "+ Add new" to register one without leaving this page.
            </p>
          )}
          {repos.length > 0 && (
            <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
              {repos.map((repo) => {
                const branches = remoteBranchesByRepo[repo.id];
                return (
                  <li key={repo.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-800/40">
                      <input
                        type="checkbox"
                        checked={selected.has(repo.id)}
                        onChange={() => toggle(repo.id)}
                      />
                      <span className="text-zinc-200">{repo.name}</span>
                      <span className="text-xs text-zinc-500">
                        {repo.owner}/{repo.repo}
                      </span>
                    </label>
                    {selected.has(repo.id) && (
                      <div className="flex items-center gap-2 px-3 pb-2 pl-8 text-xs text-zinc-400">
                        <span className="uppercase tracking-wide text-zinc-500">Branch</span>
                        <select
                          value={selectedBranchByRepo[repo.id] ?? ""}
                          disabled={branches === "loading" || branches === "error"}
                          onChange={(e) =>
                            setSelectedBranchByRepo((prev) => ({
                              ...prev,
                              [repo.id]: e.target.value,
                            }))
                          }
                          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-zinc-500 disabled:opacity-60"
                        >
                          <option value="">New branch</option>
                          {Array.isArray(branches) &&
                            branches.map((branch) => (
                              <option key={branch} value={branch}>
                                {branch}
                              </option>
                            ))}
                        </select>
                        {branches === "loading" && <span className="text-zinc-500">loading…</span>}
                        {branches === "error" && (
                          <button
                            type="button"
                            onClick={() => loadBranches(repo.id)}
                            className="text-indigo-400 hover:text-indigo-300"
                          >
                            retry
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {showAddRepo && (
            <InlineRepoCreator
              onAdded={(repo) => {
                onRepoAdded(repo);
                setSelected((prev) => new Set(prev).add(repo.id));
                loadBranches(repo.id);
                setShowAddRepo(false);
              }}
              onError={setError}
            />
          )}
        </div>

        {openTasks.length > 0 && (
          <label className="block text-xs text-zinc-400">
            <span className="mb-1 block uppercase tracking-wide">Link a task (optional)</span>
            <select
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            >
              <option value="">None</option>
              {openTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-zinc-500">
              Archiving the workspace will mark a linked task done.
            </span>
          </label>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact repo-create form embedded in the New Workspace flow so a user can
 * register a repo without bouncing to Settings. Captures just the essentials;
 * setup/run scripts can still be edited later in Settings → Repositories.
 */
function InlineRepoCreator({
  onAdded,
  onError,
}: {
  onAdded: (repo: Repo) => void;
  onError: (message: string | null) => void;
}) {
  const [cloneUrl, setCloneUrl] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const url = cloneUrl.trim();
    if (!url) {
      onError("A clone URL is required.");
      return;
    }
    setSaving(true);
    onError(null);
    try {
      const repo = await createRepo({
        cloneUrl: url,
        name: name.trim() || undefined,
      });
      setCloneUrl("");
      setName("");
      onAdded(repo);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-zinc-700 bg-zinc-900 p-3">
      <input
        value={cloneUrl}
        placeholder="git@github.com:owner/repo.git"
        onChange={(e) => setCloneUrl(e.target.value)}
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
      />
      <input
        value={name}
        placeholder="Display name (optional)"
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">
          Setup/run scripts can be added later in Settings → Repositories.
        </p>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save repo"}
        </button>
      </div>
    </div>
  );
}

/** How often the open workspace re-fetches its detail so PR / checks cache
 *  freshness from the background poller surfaces without a manual reload. The
 *  poller itself runs every 60s, so a slightly faster cadence here ensures one
 *  fresh poll lands per refresh while still being cheap (one local SQL read). */
const DETAIL_REFRESH_INTERVAL_MS = 20_000;

function WorkspaceDetailView({
  id,
  onChanged,
  claudePrompt,
  autoStartClaude = false,
}: {
  id: string;
  onChanged: () => void;
  /** When set (Issues "Start work"), auto-provision then launch a Claude session
   * seeded with this prompt. */
  claudePrompt?: string;
  /** When true (a workspace just created here, no issue prompt), start a
   * remote-control Claude session once provisioning finishes and focus it. */
  autoStartClaude?: boolean;
}) {
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runRepo, setRunRepo] = useState<WorkspaceRepoDetail | null>(null);
  const [provisionLog, setProvisionLog] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  // Flips once the issue prompt file has been written (post-provision), gating
  // the Claude terminal launch.
  const [claudePromptReady, setClaudePromptReady] = useState(false);
  // The configured base command for Claude, loaded from the core; used to build
  // the issue "Start work" launch line. Falls back to the default until loaded.
  const [claudeCommand, setClaudeCommand] = useState(DEFAULT_CLAUDE_COMMAND);
  // A changed file the side panel asked to open in a diff tab; consumed by
  // TerminalTabs, which either opens a new tab or re-focuses the existing one.
  const [diffRequest, setDiffRequest] = useState<OpenFileDiff | null>(null);
  // A failed repo's setup log to open in a tab (same request/consume shape as
  // diffRequest). Set by the auto-open effect below and the per-repo button.
  const [setupLogRequest, setSetupLogRequest] = useState<OpenSetupLog | null>(null);
  // Guards the one-shot auto-open of a failed repo's setup log. Per-mount, and
  // the view is keyed by workspace id, so it re-arms when you switch workspaces.
  const setupAutoOpenedRef = useRef(false);
  const autoProvisionRef = useRef(false);
  const promptWriteRef = useRef(false);
  const autoStartClaudeRef = useRef(false);
  const [claudeActive, setClaudeActive] = useState(false);
  // Bumped when the active id changes (or this view unmounts) so an in-flight
  // load() from a previous selection won't overwrite the new one's detail.
  // Capture the current value at call time; compare on resolve.
  const generationRef = useRef(0);
  // Draggable split sizes, shared across all workspaces (one preference, not
  // per-id) so a size you like sticks as you move between workspaces.
  const [sideRatio, setSideRatio] = usePersistedRatio("yarvis.workspaces.sideRatio", 0.72);
  const [runRatio, setRunRatio] = usePersistedRatio("yarvis.workspaces.runRatio", 0.6);

  const load = useCallback(async () => {
    const gen = generationRef.current;
    try {
      const next = await getWorkspace(id);
      if (gen !== generationRef.current) return;
      setDetail(next);
      setError(null);
    } catch (e) {
      if (gen !== generationRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  // Initial fetch + polling combined: chained setTimeout in `finally` ensures a
  // slow load doesn't overlap the next tick (the setInterval shape did). Each
  // mount/id change increments the generation so any still-resolving call from
  // the previous run is dropped at write time (see `load` above). Skipped while
  // the tab is hidden so a backgrounded app isn't hitting the sidecar; on
  // return we fire one immediate load and resume.
  useEffect(() => {
    generationRef.current += 1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;

    const tick = async () => {
      await load();
      if (live && !document.hidden) {
        timer = setTimeout(tick, DETAIL_REFRESH_INTERVAL_MS);
      }
    };
    const onVisibility = () => {
      if (!document.hidden && live && timer === null) {
        void tick();
      }
    };

    void tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      generationRef.current += 1;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  // Poll whether a Claude session is live in the core, so the workspace can
  // surface it as a pinned terminal tab — whether it was started here, by the
  // agent, or remotely.
  useEffect(() => {
    if (detail?.status !== "active") return;
    const claudeId = `ws-claude:${id}`;
    let cancelled = false;
    const check = async () => {
      try {
        const alive = await ptyExists(claudeId);
        if (!cancelled) setClaudeActive(alive);
      } catch {
        // Core unreachable; leave the last known state in place.
      }
    };
    void check();
    const timer = setInterval(check, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, detail?.status]);

  // When a workspace with a failed repo loads — whether provisioning just failed
  // here, or the user reopened an errored workspace — auto-open that repo's
  // setup-log tab so the failure is visible without hunting for it. Fires once
  // per mount; the per-repo "Setup log" button below reopens it after a close.
  useEffect(() => {
    if (setupAutoOpenedRef.current || !detail) return;
    const failed = detail.repos.find((wr) => wr.status === "error");
    if (!failed) return;
    setupAutoOpenedRef.current = true;
    setSetupLogRequest({ workspaceRepoId: failed.id, title: failed.repo.name });
  }, [detail]);

  const provision = useCallback(async () => {
    setProvisionLog("");
    try {
      const result = await consumeProvision(id, (text) =>
        setProvisionLog((prev) => (prev ?? "") + text),
      );
      // Clear the live log and reload regardless of outcome: a repo failure lands
      // on the detail view, where the auto-open effect surfaces the setup-log tab.
      // Re-arm that one-shot so this fresh failure opens even after an earlier one.
      setProvisionLog(null);
      setupAutoOpenedRef.current = false;
      await load();
      onChanged();
      // Only a hard top-level error collapses the view; a repo failure stays put.
      if (result.error) setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, load, onChanged]);

  // Issue "Start work" handoff. First auto-provision a freshly created
  // workspace (the user didn't come here to click "Provision"); the ref guards
  // against re-firing on each poll.
  useEffect(() => {
    if (!claudePrompt || !detail) return;
    if (detail.status === "creating" && provisionLog === null && !autoProvisionRef.current) {
      autoProvisionRef.current = true;
      void provision();
    }
  }, [claudePrompt, detail, provisionLog, provision]);

  // Once provisioned, write the prompt file so the Claude terminal can launch
  // against it. Runs once (ref-guarded).
  useEffect(() => {
    if (!claudePrompt || !detail) return;
    if (detail.status === "active" && !promptWriteRef.current) {
      promptWriteRef.current = true;
      writeIssuePromptFile(detail.id, claudePrompt)
        .then(() => setClaudePromptReady(true))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [claudePrompt, detail]);

  // Load the configured base Claude command up front so the issue terminal
  // launches with it; harmless when there's no issue prompt.
  useEffect(() => {
    getClaudeCommand()
      .then((cmd) => setClaudeCommand(cmd || DEFAULT_CLAUDE_COMMAND))
      .catch(() => setClaudeCommand(DEFAULT_CLAUDE_COMMAND));
  }, []);

  const startClaude = useCallback(async () => {
    if (!detail) return;
    try {
      await startClaudeSession(id, claudeCwdForWorkspace(detail), detail.name);
      // The session now exists; reflect it immediately (the poll would catch up).
      setClaudeActive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, detail]);

  // "New workspace" handoff: once a freshly created workspace is provisioned,
  // start a remote-control Claude session so it's ready to drive. The pinned
  // Claude tab that appears is auto-focused by TerminalTabs, navigating to it.
  // Ref-guarded to fire once; skipped for the issue flow (its own launch path).
  useEffect(() => {
    if (!autoStartClaude || claudePrompt) return;
    if (detail?.status !== "active") return;
    if (claudeActive || autoStartClaudeRef.current) return;
    autoStartClaudeRef.current = true;
    void startClaude();
  }, [autoStartClaude, claudePrompt, detail?.status, claudeActive, startClaude]);

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!detail) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;

  const provisioned = detail.status === "active";
  const claudeCwd = claudeCwdForWorkspace(detail);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-zinc-100">{detail.name}</h2>
          <StatusBadge status={detail.status} />
          <span className="ml-auto truncate font-mono text-xs text-zinc-500">
            {detail.rootPath}
          </span>
          {provisioned && !claudeActive && (
            <button
              type="button"
              onClick={() => void startClaude()}
              className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Start Claude session
            </button>
          )}
          {detail.status !== "archived" && (
            <button
              type="button"
              onClick={() => setShowArchive(true)}
              className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Archive
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {detail.repos.map((wr) => (
            <div
              key={wr.id}
              className="flex items-center gap-2 rounded-md border border-zinc-800 px-2 py-1 text-xs"
            >
              <span className="text-zinc-200">{wr.repo.name}</span>
              <span className="font-mono text-zinc-500">{wr.branch}</span>
              <RepoStatusBadge status={wr.status} />
              {wr.repo.runScript && wr.status === "ready" && (
                <button
                  type="button"
                  onClick={() => setRunRepo(wr)}
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
                >
                  Run
                </button>
              )}
              {wr.status === "error" && (
                <button
                  type="button"
                  onClick={() =>
                    setSetupLogRequest({ workspaceRepoId: wr.id, title: wr.repo.name })
                  }
                  className="rounded border border-red-900/60 px-1.5 py-0.5 text-red-300 hover:bg-red-950/40"
                >
                  Setup log
                </button>
              )}
            </div>
          ))}
        </div>
        {provisioned && detail.repos.some((wr) => wr.status === "ready") && (
          <div className="mt-2 space-y-1.5 border-t border-zinc-800 pt-2">
            {detail.repos
              .filter((wr) => wr.status === "ready")
              .map((wr) => (
                <WorkspacePrStatus
                  key={wr.id}
                  workspaceId={detail.id}
                  repo={wr}
                  showRepoName={detail.repos.length > 1}
                />
              ))}
          </div>
        )}
        {detail.tasks.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span className="uppercase tracking-wide">Tasks</span>
            {detail.tasks.map((t) => (
              <span
                key={t.id}
                className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-0.5"
              >
                <span className={t.status === "done" ? "text-emerald-400" : "text-zinc-300"}>
                  {t.status === "done" ? "✓" : "○"} {t.title}
                </span>
                {detail.status !== "archived" && (
                  <button
                    type="button"
                    onClick={() =>
                      void unlinkWorkspaceTask(id, t.id).then(() => {
                        void load();
                        onChanged();
                      })
                    }
                    className="text-zinc-600 hover:text-zinc-300"
                    aria-label="Unlink task"
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {detail.issues.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span className="uppercase tracking-wide">Issues</span>
            {detail.issues.map((issue) => (
              <span
                key={`${issue.provider}:${issue.sourceKey}#${issue.externalId}`}
                className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-0.5"
              >
                <span className="rounded bg-zinc-800 px-1 text-[10px] uppercase text-zinc-400">
                  {issue.provider}
                </span>
                {issue.url ? (
                  <a
                    href={issue.url}
                    onClick={(e) => {
                      e.preventDefault();
                      openExternal(issue.url);
                    }}
                    className="text-zinc-300 hover:text-zinc-100"
                  >
                    {issue.title ?? issue.externalId}
                  </a>
                ) : (
                  <span className="text-zinc-300">{issue.title ?? issue.externalId}</span>
                )}
                {detail.status !== "archived" && (
                  <button
                    type="button"
                    onClick={() =>
                      void unlinkWorkspaceIssue(id, issue).then(() => {
                        void load();
                        onChanged();
                      })
                    }
                    className="text-zinc-600 hover:text-zinc-300"
                    aria-label="Unlink issue"
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {detail.status !== "archived" && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowLinkModal(true)}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              + Link work…
            </button>
          </div>
        )}
      </div>

      {showLinkModal && (
        <LinkWorkModal
          detail={detail}
          onClose={() => setShowLinkModal(false)}
          onLinked={async () => {
            await load();
            onChanged();
          }}
        />
      )}

      {showArchive && (
        <ArchiveDialog
          detail={detail}
          onClose={() => setShowArchive(false)}
          onArchived={async () => {
            setShowArchive(false);
            await load();
            onChanged();
          }}
          onError={(m) => setError(m)}
        />
      )}

      {!provisioned && provisionLog === null && (
        <div className="shrink-0 border-b border-zinc-800 px-4 py-2">
          <button
            type="button"
            onClick={() => void provision()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
          >
            {detail.status === "error"
              ? "Retry provisioning"
              : detail.repos.length === 0
                ? "Create folder"
                : "Provision worktrees"}
          </button>
        </div>
      )}

      {provisionLog !== null ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap bg-[#09090b] p-3 font-mono text-xs text-zinc-300">
          {provisionLog || "Starting…"}
        </pre>
      ) : detail.status === "archived" ? (
        <ArchivedView detail={detail} />
      ) : (
        <SplitPane
          className="flex-1"
          orientation="horizontal"
          ratio={sideRatio}
          onRatioChange={setSideRatio}
          first={(() => {
            // The workspace's Claude session always rides along as a pinned
            // terminal tab, so every workspace — including ones started from an
            // issue — keeps iTerm-style tabs and Cmd+D pane splits for its own
            // shells. See `resolveClaudeTab` for how the issue and remote-control
            // flows differ.
            const claudeTab = resolveClaudeTab({
              claudePrompt,
              claudePromptReady,
              claudeActive,
              workspaceId: detail.id,
              rootPath: detail.rootPath,
              claudeCwd,
              claudeCommand,
            });
            const terminalArea = (
              <div className="h-full min-h-0 min-w-0">
                <TerminalTabs
                  storageKey={`ws:${detail.id}`}
                  cwd={detail.rootPath}
                  openFileDiff={diffRequest}
                  onFileDiffOpened={() => setDiffRequest(null)}
                  renderFileDiff={({ repoId, path }) => (
                    <WorkspaceFileDiff workspaceId={detail.id} repoId={repoId} path={path} />
                  )}
                  openSetupLog={setupLogRequest}
                  onSetupLogOpened={() => setSetupLogRequest(null)}
                  renderSetupLog={({ workspaceRepoId }) => {
                    const wr = detail.repos.find((r) => r.id === workspaceRepoId);
                    return wr ? (
                      <WorkspaceSetupLog repo={wr} />
                    ) : (
                      <p className="p-3 text-xs text-zinc-500">
                        This repo is no longer part of the workspace.
                      </p>
                    );
                  }}
                  pinnedTabs={claudeTab ? [claudeTab] : []}
                />
              </div>
            );
            if (!runRepo) return terminalArea;
            const runPanel = (
              <div className="flex h-full min-h-0 min-w-0 flex-col">
                <div className="flex shrink-0 items-center justify-between bg-zinc-900 px-3 py-1 text-xs text-zinc-400">
                  <span>
                    run · {runRepo.repo.name}{" "}
                    <span className="font-mono text-zinc-600">{runRepo.repo.runScript}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setRunRepo(null)}
                    className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800"
                  >
                    Close
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <TerminalPanel
                    sessionId={`ws-run:${runRepo.id}`}
                    cwd={runRepo.worktreePath}
                    initialCommand={runRepo.repo.runScript ?? undefined}
                  />
                </div>
              </div>
            );
            return (
              <SplitPane
                className="h-full w-full"
                orientation="vertical"
                ratio={runRatio}
                onRatioChange={setRunRatio}
                first={terminalArea}
                second={runPanel}
              />
            );
          })()}
          second={
            <WorkspaceSidePanel
              workspaceId={detail.id}
              repos={detail.repos}
              onOpenFile={(repoId, path) => setDiffRequest({ repoId, path })}
            />
          }
        />
      )}
    </div>
  );
}
