import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeIssuePromptFile } from "../lib/issues/api";
import type { OpenWorkspaceRequest } from "../lib/nav";
import { getClaudeCommand, ptyExists, startClaudeSession } from "../lib/pty";
import { createRepo, listRepos, type Repo } from "../lib/repos";
import { listTasks, type Task } from "../lib/tasks";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  type ProvisionEvent,
  provisionWorkspace,
  unlinkWorkspaceTask,
  type WorkspaceDetail,
  type WorkspaceRepoDetail,
  type WorkspaceRepoStatus,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "../lib/workspaces";
import TerminalTabs from "./shell/terminalTabs/TerminalTabs";
import TerminalPanel from "./TerminalPanel";
import WorkspaceSidePanel from "./WorkspaceSidePanel";
import ArchiveDialog from "./workspaces/ArchiveDialog";
import ArchivedView from "./workspaces/ArchivedView";
import LinkTaskControl from "./workspaces/LinkTaskControl";

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

/** Human-readable line for a provisioning progress event, or null to ignore. */
function provisionEventLine(ev: ProvisionEvent): string | null {
  if (ev.type === "log") return ev.text;
  if (ev.type === "repo-start") return `\n=== ${ev.repo} ===\n`;
  if (ev.type === "repo-error") return `\n[error] ${ev.message}\n`;
  return null;
}

/**
 * Drives a provision stream, appending progress text via `onLine`. Resolves
 * with the outcome so callers can react (select the workspace, reload, etc.).
 */
async function consumeProvision(
  id: string,
  onLine: (text: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  for await (const ev of provisionWorkspace(id)) {
    const line = provisionEventLine(ev);
    if (line !== null) onLine(line);
    else if (ev.type === "error") return { ok: false, error: ev.message };
    else if (ev.type === "done") return { ok: true };
  }
  return { ok: true };
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
      const repo = ws.repoNames[0] ?? "(no repo)";
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

/**
 * Instruction handed to Claude for an "Start work on issue" session. The issue
 * details are written to a known file under the workspace root (see the sidecar
 * `/prompt-file` route), so a static instruction to read that file is enough —
 * no need to inline the (potentially large) body into the command.
 */
const CLAUDE_ISSUE_INSTRUCTION =
  "Read the ticket details in .yarvis/issue-prompt.md and implement a first pass at the ticket, following the repository's conventions.";

/** Fallback base command while the configured one is still loading (matches the
 *  Rust core's default). */
const DEFAULT_CLAUDE_COMMAND = "claude --permission-mode auto";

/**
 * Builds the issue "Start work" launch line from the configured base command
 * (e.g. `claude --permission-mode auto`), appending the instruction as a
 * double-quoted argument. The instruction contains an apostrophe but no double
 * quotes, so double-quote wrapping is safe.
 */
function buildClaudeIssueCommand(base: string): string {
  return `${base} "${CLAUDE_ISSUE_INSTRUCTION}"`;
}

/** Where a workspace's Claude session runs: the lone repo's worktree, or the
 *  workspace root when it spans several (so Claude sees each worktree as a
 *  subfolder). */
function claudeCwdForWorkspace(detail: WorkspaceDetail): string {
  const first = detail.repos[0];
  return detail.repos.length === 1 && first ? first.worktreePath : detail.rootPath;
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

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!name.trim() || selected.size === 0) {
      setError("Pick a name and at least one repo.");
      return;
    }
    try {
      const ws = await createWorkspace({
        name: name.trim(),
        repoIds: [...selected],
        taskId: taskId || undefined,
      });
      setPhase("provisioning");
      const result = await consumeProvision(ws.id, (text) => setLog((prev) => prev + text));
      if (result.ok) onCreated(ws.id);
      else setError(result.error ?? "provisioning failed");
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
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Repos</div>
            <button
              type="button"
              onClick={() => setShowAddRepo((v) => !v)}
              className="text-xs text-indigo-400 hover:text-indigo-300"
            >
              {showAddRepo ? "Cancel" : "+ Add new"}
            </button>
          </div>
          {repos.length === 0 && !showAddRepo && (
            <p className="text-xs text-zinc-500">
              No repos registered. Click "+ Add new" to register one without leaving this page.
            </p>
          )}
          {repos.length > 0 && (
            <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
              {repos.map((repo) => (
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
                </li>
              ))}
            </ul>
          )}
          {showAddRepo && (
            <InlineRepoCreator
              onAdded={(repo) => {
                onRepoAdded(repo);
                setSelected((prev) => new Set(prev).add(repo.id));
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
  // Flips once the issue prompt file has been written (post-provision), gating
  // the Claude terminal launch.
  const [claudePromptReady, setClaudePromptReady] = useState(false);
  // The configured base command for Claude, loaded from the core; used to build
  // the issue "Start work" launch line. Falls back to the default until loaded.
  const [claudeCommand, setClaudeCommand] = useState(DEFAULT_CLAUDE_COMMAND);
  const autoProvisionRef = useRef(false);
  const promptWriteRef = useRef(false);
  const autoStartClaudeRef = useRef(false);
  const [claudeActive, setClaudeActive] = useState(false);
  // Bumped when the active id changes (or this view unmounts) so an in-flight
  // load() from a previous selection won't overwrite the new one's detail.
  // Capture the current value at call time; compare on resolve.
  const generationRef = useRef(0);

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

  const provision = useCallback(async () => {
    setProvisionLog("");
    try {
      const result = await consumeProvision(id, (text) =>
        setProvisionLog((prev) => (prev ?? "") + text),
      );
      if (!result.ok) {
        setError(result.error ?? "provisioning failed");
        return;
      }
      setProvisionLog(null);
      await load();
      onChanged();
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
            </div>
          ))}
        </div>
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
        {detail.status !== "archived" && (
          <div className="mt-2">
            <LinkTaskControl
              workspaceId={id}
              linkedIds={detail.tasks.map((t) => t.id)}
              onLinked={async () => {
                await load();
                onChanged();
              }}
            />
          </div>
        )}
      </div>

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
            {detail.status === "error" ? "Retry provisioning" : "Provision worktrees"}
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
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="min-h-0 min-w-0 flex-1">
              {claudePrompt ? (
                claudePromptReady ? (
                  // Fresh, stable id so a reattach never re-runs the prompt.
                  // Launched at the workspace root (like the standard terminal),
                  // where the .yarvis/issue-prompt.md file lives.
                  <TerminalPanel
                    sessionId={`ws-claude:${detail.id}`}
                    cwd={detail.rootPath}
                    initialCommand={buildClaudeIssueCommand(claudeCommand)}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                    Preparing Claude session…
                  </div>
                )
              ) : (
                /* A live remote-control Claude session shows up as a pinned
                   terminal tab; the workspace's own shells live in the other tabs. */
                <TerminalTabs
                  storageKey={`ws:${detail.id}`}
                  cwd={detail.rootPath}
                  pinnedTabs={
                    claudeActive
                      ? [
                          {
                            key: "claude",
                            title: "Claude",
                            sessionId: `ws-claude:${detail.id}`,
                            cwd: claudeCwd,
                          },
                        ]
                      : []
                  }
                />
              )}
            </div>
            {runRepo && (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-zinc-800">
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
            )}
          </div>
          <WorkspaceSidePanel workspaceId={detail.id} repos={detail.repos} />
        </div>
      )}
    </div>
  );
}
