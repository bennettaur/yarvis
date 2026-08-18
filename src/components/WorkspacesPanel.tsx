import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setViewedWorkspace } from "../lib/attentionScope";
import { useAttentionWorkspaceIds } from "../lib/attentionStore";
import type { NewWorkspaceRequest, OpenWorkspaceRequest } from "../lib/nav";
import { type AgentConfig, getAgentConfig, ptyExists, startClaudeSession } from "../lib/pty";
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
import {
  agentSessionId,
  DEFAULT_AGENT_COMMAND,
  DEFAULT_AGENT_NAME,
  resolveAgentTab,
  shouldAutoStartAgent,
} from "./workspaces/agentTab";
import BranchCombobox from "./workspaces/BranchCombobox";
import LinkWorkModal from "./workspaces/LinkWorkModal";
import { consumeProvision } from "./workspaces/provisionStream";
import WorkspaceFileDiff from "./workspaces/WorkspaceFileDiff";
import WorkspacePrBadges from "./workspaces/WorkspacePrBadges";
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

/** How often the list and the open workspace re-fetch, so PR / checks cache
 *  freshness from the background poller surfaces without a manual reload. The
 *  poller itself runs every 60s, so a slightly faster cadence ensures one fresh
 *  poll lands per refresh while still being cheap (one local SQL read). */
const CACHE_REFRESH_INTERVAL_MS = 20_000;

/** Cadence used while a workspace is mid-archive: the teardown runs in the
 *  sidecar's background, so both the list and the open workspace lean on
 *  polling to notice it landed. */
const ARCHIVING_REFRESH_INTERVAL_MS = 2_000;

/** Where a workspace's agent session runs: always the workspace root, so the
 *  agent sees each repo's worktree as a subfolder and can read the
 *  `.yarvis/issue-prompt.md` seeded there for an issue "Start work" session. */
function agentCwdForWorkspace(detail: WorkspaceDetail): string {
  return detail.rootPath;
}

export default function WorkspacesPanel({
  requested = null,
  onRequestConsumed,
  requestedNew = null,
  onNewRequestConsumed,
}: {
  /** A workspace another tab asked us to open. */
  requested?: OpenWorkspaceRequest | null;
  /** Called once we've consumed `requested` so the parent can clear it. */
  onRequestConsumed?: () => void;
  /** Another tab asked us to open the New Workspace form pre-filled (Tasks). */
  requestedNew?: NewWorkspaceRequest | null;
  /** Called once we've consumed `requestedNew` so the parent can clear it. */
  onNewRequestConsumed?: () => void;
} = {}) {
  const [items, setItems] = useState<WorkspaceSummary[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_WORKSPACE_KEY),
  );
  // A terminal session an attention item asked us to bring into view, scoped to
  // one workspace id for the same reason. Consumed by the terminal surface.
  const [focusSession, setFocusSession] = useState<{ id: string; sessionKey: string } | null>(null);
  const [creating, setCreating] = useState(false);
  // Pre-fill (name/taskId) plus a pending Claude prompt for the New Workspace
  // form, applied when another tab (Tasks) hands off a "create workspace" or
  // "start work" request. Cleared alongside `creating`.
  const [newWorkspacePrefill, setNewWorkspacePrefill] = useState<NewWorkspaceRequest | null>(null);
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

  // Publish which workspace is on screen so anything it raised clears itself
  // once the user is actually looking at it.
  useEffect(() => {
    setViewedWorkspace(selectedId);
    return () => setViewedWorkspace(null);
  }, [selectedId]);

  // Honor a cross-tab open request (Issues "Start work"): select the workspace.
  // Nothing about the kick-off rides along — the sidecar holds the prompt on the
  // workspace row, so the detail view picks it up from there.
  useEffect(() => {
    if (!requested) return;
    setCreating(false);
    setSelectedId(requested.id);
    setFocusSession(
      requested.focusSessionKey
        ? { id: requested.id, sessionKey: requested.focusSessionKey }
        : null,
    );
    onRequestConsumed?.();
  }, [requested, onRequestConsumed]);

  // Honor a cross-tab "new workspace" request (Tasks): open the New form with
  // the task's name and link pre-filled. The Claude prompt (if any) rides along
  // to the sidecar when the form creates the workspace.
  useEffect(() => {
    if (!requestedNew) return;
    setSelectedId(null);
    setNewWorkspacePrefill(requestedNew);
    setCreating(true);
    onNewRequestConsumed?.();
  }, [requestedNew, onNewRequestConsumed]);

  useEffect(() => {
    if (showArchived) localStorage.setItem(SHOW_ARCHIVED_KEY, "1");
    else localStorage.removeItem(SHOW_ARCHIVED_KEY);
  }, [showArchived]);

  // An archive finishes in the sidecar's background, so keep the list in step
  // while one is in flight — including when the user has moved on to another
  // workspace, which leaves nothing else polling for it. `archiving` with no
  // error is a teardown still running; one that stopped on a dirty worktree
  // carries the error and waits on the user, so it stops the polling.
  const archivingCount = useMemo(
    () => items.filter((w) => w.status === "archiving" && w.error === null).length,
    [items],
  );
  useEffect(() => {
    if (archivingCount === 0) return;
    const timer = setInterval(() => void refresh(), ARCHIVING_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [archivingCount, refresh]);

  // Keeps the rows' PR badges current. Chained rather than on an interval so a
  // slow fetch can't overlap the next tick, and it re-reads only the list — the
  // repos behind it don't change on the poller's account. A failed tick leaves
  // the last-known rows and says nothing: the user didn't ask for this fetch,
  // so a transient sidecar hiccup must not paint an error over the list.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      timer = null;
      try {
        const ws = await listWorkspaces();
        if (live) setItems(ws);
      } catch {
        // Keep what's on screen; the next tick tries again.
      }
      if (live && !document.hidden) timer = setTimeout(tick, CACHE_REFRESH_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (!document.hidden && live && timer === null) void tick();
    };

    timer = setTimeout(tick, CACHE_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // A selected workspace missing from the list is usually one created since the
  // last fetch — the create and "Start work" flows select it immediately, while
  // `items` still holds the pre-create list — so confirm it's really gone before
  // dropping the selection. If it exists, pull it into the list instead.
  const verifiedSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || items.length === 0) return;
    if (items.some((w) => w.id === selectedId)) return;
    // One verification per selection: a workspace that survives the check but
    // still doesn't reach the list must not re-trigger this on every refresh.
    if (verifiedSelectionRef.current === selectedId) return;
    verifiedSelectionRef.current = selectedId;
    let active = true;
    getWorkspace(selectedId)
      .then(() => {
        if (active) void refresh();
      })
      .catch(() => {
        if (active) setSelectedId(null);
      });
    return () => {
      active = false;
    };
  }, [items, selectedId, refresh]);

  const visibleItems = useMemo(
    () => (showArchived ? items : items.filter((w) => w.status !== "archived")),
    [items, showArchived],
  );
  const archivedCount = useMemo(() => items.filter((w) => w.status === "archived").length, [items]);

  const groups = useMemo(() => groupWorkspaces(visibleItems), [visibleItems]);
  const workspacesNeedingAttention = useAttentionWorkspaceIds();

  const beginNew = () => {
    setCreating(true);
    setNewWorkspacePrefill(null);
    setSelectedId(null);
    setFocusSession(null);
  };

  const onCreated = async (id: string) => {
    // Fetch the list containing the new workspace before switching to it, so the
    // sidebar highlights it as we open its detail view.
    await refresh();
    setCreating(false);
    setNewWorkspacePrefill(null);
    setSelectedId(id);
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
                {group.items.map((ws) => {
                  const needsAttention = workspacesNeedingAttention.has(ws.id);
                  return (
                    <li key={ws.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setCreating(false);
                          setSelectedId(ws.id);
                          setFocusSession(null);
                        }}
                        title={needsAttention ? `${ws.name} — needs you` : ws.name}
                        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-800/60 ${
                          selectedId === ws.id
                            ? "bg-zinc-800 text-zinc-100"
                            : needsAttention
                              ? "text-amber-300"
                              : "text-zinc-300"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          {/* Marks a workspace asking for the user while they're
                              looking at a different one. */}
                          {needsAttention && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                          )}
                          <span className="truncate">{ws.name}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <WorkspacePrBadges prs={ws.prs} />
                          <StatusBadge status={ws.status} />
                        </span>
                      </button>
                    </li>
                  );
                })}
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
            // Key on the prefill so a fresh handoff (e.g. a second task's
            // "Start work" while the form is already open) resets every field
            // — the form's state is initialized only on mount.
            key={newWorkspacePrefill?.taskId ?? "blank"}
            repos={repos}
            prefill={newWorkspacePrefill}
            onCancel={() => {
              setCreating(false);
              setNewWorkspacePrefill(null);
            }}
            onCreated={onCreated}
            onRepoAdded={onRepoAdded}
          />
        ) : selectedId ? (
          <WorkspaceDetailView
            key={selectedId}
            id={selectedId}
            onChanged={refresh}
            focusSession={focusSession?.id === selectedId ? focusSession.sessionKey : undefined}
            onFocusSessionHandled={() => setFocusSession(null)}
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
  prefill,
  onCancel,
  onCreated,
  onRepoAdded,
}: {
  repos: Repo[];
  /** Pre-fill from a cross-tab handoff (Tasks): name, taskId, Claude prompt. */
  prefill?: NewWorkspaceRequest | null;
  onCancel: () => void;
  onCreated: (id: string) => void;
  onRepoAdded: (repo: Repo) => void;
}) {
  const [name, setName] = useState(prefill?.name ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // repo id -> chosen existing branch ("" means cut a fresh branch).
  const [selectedBranchByRepo, setSelectedBranchByRepo] = useState<Record<string, string>>({});
  // repo id -> its fetched remote branches, or a loading/error sentinel.
  const [remoteBranchesByRepo, setRemoteBranchesByRepo] = useState<
    Record<string, string[] | "loading" | "error">
  >({});
  const [taskId, setTaskId] = useState(prefill?.taskId ?? "");
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
        // A "Start work" handoff (Tasks) seeds the agent session; the sidecar
        // holds it so the launch doesn't depend on this form staying mounted.
        issuePrompt: prefill?.claudePrompt,
      });
      setPhase("provisioning");
      const result = await consumeProvision(ws.id, (text) => setLog((prev) => prev + text));
      // A hard top-level error (workspace not found, a provision that failed
      // outright) has no useful detail view, so stay on the log screen.
      // Otherwise — success or a repo whose setup failed — open the workspace:
      // its detail view auto-opens the failed repo's setup-log tab.
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
            Leave empty for a scratch workspace — just a folder to run an agent in, for
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
                        <BranchCombobox
                          branches={branches ?? "loading"}
                          value={selectedBranchByRepo[repo.id] ?? ""}
                          onChange={(branch) =>
                            setSelectedBranchByRepo((prev) => ({
                              ...prev,
                              [repo.id]: branch,
                            }))
                          }
                        />
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

function WorkspaceDetailView({
  id,
  onChanged,
  focusSession,
  onFocusSessionHandled,
}: {
  id: string;
  onChanged: () => void;
  /** A PTY session (from an attention item) to bring into view in this
   * workspace's terminal surface. */
  focusSession?: string;
  /** Called once the terminal surface has consumed `focusSession`. */
  onFocusSessionHandled?: () => void;
}) {
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runRepo, setRunRepo] = useState<WorkspaceRepoDetail | null>(null);
  const [provisionLog, setProvisionLog] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  // The configured agent, loaded from the core: its tab title and the base
  // command the issue "Start work" launch line is built from. Falls back to the
  // defaults until loaded.
  const [agent, setAgent] = useState<AgentConfig>({
    name: DEFAULT_AGENT_NAME,
    command: DEFAULT_AGENT_COMMAND,
  });
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
  // Guards the one-shot auto-start. Per-mount, and the view is keyed by workspace
  // id, so it re-arms when you switch workspaces — the auto-start effect re-runs
  // on every detail poll, so this ref is what stops it firing more than once.
  const autoStartAgentRef = useRef(false);
  const [agentActive, setAgentActive] = useState(false);
  // Flips once the liveness poll below has answered for this workspace. Auto-start
  // waits on it so an already-running session isn't spawned a second time.
  const [agentProbed, setAgentProbed] = useState(false);
  // Set when the user closes the agent tab, so neither the pinned-tab resolver
  // nor auto-start puts it back. Scoped to this view, which is keyed by workspace
  // id: opening the workspace again is treated as asking for an agent again.
  const [agentDismissed, setAgentDismissed] = useState(false);
  // Why the last agent launch failed, shown in the header. Non-fatal; see
  // `startAgent`.
  const [agentError, setAgentError] = useState<string | null>(null);
  // Bumped when the active id changes (or this view unmounts) so an in-flight
  // load() from a previous selection won't overwrite the new one's detail.
  // Capture the current value at call time; compare on resolve.
  const generationRef = useRef(0);
  // The last status this view saw, so a change the poll discovers can be pushed
  // to the parent list. Null until the first load resolves.
  const statusRef = useRef<WorkspaceStatus | null>(null);
  // Whether a teardown is still running (as opposed to parked on a dirty
  // worktree). Drives the poll's cadence, so it's state rather than a ref: the
  // loop has to restart at the faster tempo the moment an archive starts.
  const [archiveRunning, setArchiveRunning] = useState(false);
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
      // A status the poll picked up on its own — a background archive landing,
      // say — also has to reach the sidebar's list row.
      if (next && statusRef.current !== null && next.status !== statusRef.current) {
        onChanged();
      }
      statusRef.current = next?.status ?? null;
      setArchiveRunning(next?.status === "archiving" && next.error === null);
    } catch (e) {
      if (gen !== generationRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, onChanged]);

  // Initial fetch + polling combined: chained setTimeout in `finally` ensures a
  // slow load doesn't overlap the next tick (the setInterval shape did). Each
  // mount/id change increments the generation so any still-resolving call from
  // the previous run is dropped at write time (see `load` above). Skipped while
  // the tab is hidden so a backgrounded app isn't hitting the sidecar; on
  // return we fire one immediate load and resume. A running background archive
  // restarts the loop at a faster cadence so it lands without a manual reload.
  useEffect(() => {
    generationRef.current += 1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;

    const tick = async () => {
      await load();
      if (live && !document.hidden) {
        timer = setTimeout(
          tick,
          archiveRunning ? ARCHIVING_REFRESH_INTERVAL_MS : CACHE_REFRESH_INTERVAL_MS,
        );
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
  }, [load, archiveRunning]);

  // Poll whether an agent session is live in the core, so the workspace can
  // surface it as a pinned terminal tab — whether it was started here, by the
  // agent, or remotely.
  useEffect(() => {
    if (detail?.status !== "active") return;
    const sessionId = agentSessionId(id);
    let cancelled = false;
    const check = async () => {
      try {
        const alive = await ptyExists(sessionId);
        if (cancelled) return;
        setAgentActive(alive);
        setAgentProbed(true);
      } catch {
        // Core unreachable; leave the last known state in place. `agentProbed`
        // stays false, so auto-start holds off rather than spawning blind.
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

  // Auto-provision a workspace whose kick-off is still running. The sidecar
  // drives it whether or not anyone is here, so this only joins the run already
  // going — which is what puts its log on screen. The ref stops it re-firing on
  // every poll.
  useEffect(() => {
    if (detail?.status !== "creating" || provisionLog !== null) return;
    if (autoProvisionRef.current) return;
    autoProvisionRef.current = true;
    void provision();
  }, [detail?.status, provisionLog, provision]);

  // Load the configured agent up front so the tab is titled correctly and the
  // issue terminal launches with the right command.
  useEffect(() => {
    // The core resolves both fields to non-empty defaults, so take them as given.
    // A failure is worth surfacing: falling back silently would launch the
    // built-in Claude command for someone who configured a different agent.
    // A result that is somehow empty keeps the defaults rather than replacing
    // them: `agent.name` is read unguarded during render, so storing a nullish
    // config would take the whole workspace view down with it.
    getAgentConfig()
      .then((config) => {
        if (config) setAgent(config);
      })
      .catch((e) =>
        setAgentError(
          `Could not load the configured agent (${e instanceof Error ? e.message : String(e)}); using the default.`,
        ),
      );
  }, []);

  // A launch failure (e.g. the session cap) is reported beside the header button
  // rather than as the view's `error`, which replaces the whole workspace. Now
  // that every workspace launches an agent on open, a fatal one would make the
  // workspace unusable over a session that isn't essential to reading it.
  const startAgent = useCallback(async () => {
    if (!detail) return;
    setAgentError(null);
    try {
      // No Remote Control: this session opens in a tab right here. Enable it
      // from inside the session if the work has to continue away from the machine.
      await startClaudeSession(id, agentCwdForWorkspace(detail), detail.name, false);
      // The session now exists; reflect it immediately (the poll would catch up).
      setAgentActive(true);
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    }
  }, [id, detail]);

  // Every provisioned workspace surfaces an agent session, so opening one is
  // enough to get a tab you can drive. The pinned tab that appears is
  // auto-focused by TerminalTabs, navigating to it. See `shouldAutoStartAgent`
  // for what has to hold first.
  useEffect(() => {
    const start = shouldAutoStartAgent({
      dismissed: agentDismissed,
      workspaceStatus: detail?.status ?? "",
      probed: agentProbed,
      agentActive,
      alreadyStarted: autoStartAgentRef.current,
    });
    if (!start) return;
    autoStartAgentRef.current = true;
    void startAgent();
  }, [agentDismissed, detail?.status, agentProbed, agentActive, startAgent]);

  // Closing the agent tab means closing it: TerminalTabs kills the session, and
  // dropping it from `pinnedTabs` here is what removes the header. Until this
  // existed the tab lingered — and one carrying an `initialCommand` relaunched
  // its session on the next reattach.
  const dismissAgent = useCallback(() => {
    setAgentDismissed(true);
    setAgentActive(false);
  }, []);

  // Bring the agent tab back. When a session is already live — something else
  // started one in this workspace — this only un-hides the tab. Otherwise
  // start first: showing the tab before the session exists would let it attach to
  // a bare shell of its own, and re-run the prompt in the issue flow.
  const showAgent = useCallback(async () => {
    if (!agentActive) await startAgent();
    setAgentDismissed(false);
  }, [agentActive, startAgent]);

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!detail) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;

  const provisioned = detail.status === "active";
  const agentCwd = agentCwdForWorkspace(detail);
  // A background teardown that couldn't remove a worktree parks the workspace
  // in `archiving` with the failure recorded, so the button becomes the retry.
  const archiveBlocked = detail.status === "archiving" && detail.error !== null;
  const archiveLabel = archiveBlocked
    ? "Retry archive"
    : detail.status === "archiving"
      ? "Archiving…"
      : "Archive";

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-zinc-100">{detail.name}</h2>
          <StatusBadge status={detail.status} />
          <span className="ml-auto truncate font-mono text-xs text-zinc-500">
            {detail.rootPath}
          </span>
          {agentError && <span className="shrink-0 text-xs text-red-400">{agentError}</span>}
          {provisioned && (!agentActive || agentDismissed) && (
            <button
              type="button"
              onClick={() => void showAgent()}
              className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Start {agent.name} session
            </button>
          )}
          {detail.status !== "archived" && (
            <button
              type="button"
              onClick={() => setShowArchive(true)}
              className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              {archiveLabel}
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
            // Only the teardown's start is awaited; load() picks up `archiving`
            // and the poll notices when the background removal lands.
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
            // The workspace's agent session rides along as a pinned terminal tab,
            // so every workspace — including ones started from an issue — keeps
            // iTerm-style tabs and Cmd+D pane splits for its own shells. See
            // `resolveAgentTab` for how the issue and remote-control flows differ.
            const agentTab = resolveAgentTab({
              agentActive,
              dismissed: agentDismissed,
              workspaceId: detail.id,
              cwd: agentCwd,
              agentName: agent.name,
            });
            const terminalArea = (
              <div className="h-full min-h-0 min-w-0">
                <TerminalTabs
                  storageKey={`ws:${detail.id}`}
                  cwd={detail.rootPath}
                  // The agent tab is what a workspace opens with, so no shell tab
                  // is spawned beside it that the user then has to close.
                  initialTab="none"
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
                  pinnedTabs={agentTab ? [agentTab] : []}
                  onClosePinned={dismissAgent}
                  focusSessionKey={focusSession ?? null}
                  onFocusSessionHandled={onFocusSessionHandled}
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
