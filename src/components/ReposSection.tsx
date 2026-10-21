import { useCallback, useEffect, useState } from "react";
import { GITHUB_ISSUES_PREFIX } from "../lib/issues/cacheKeys";
import {
  type CreateRepoInput,
  createRepo,
  deleteRepo,
  listRepos,
  type Repo,
  type RepoTracker,
  updateRepo,
} from "../lib/repos";
import { invalidatePrefix } from "../lib/resourceCache";

interface Draft {
  id?: string;
  name: string;
  cloneUrl: string;
  setupScript: string;
  runScript: string;
  pullIssues: boolean;
  // "" means no tracker set. The text fields are kept apart so switching the
  // provider back and forth in the editor doesn't lose what was typed.
  trackerProvider: "" | RepoTracker["provider"];
  azureProject: string;
  azureAreaPath: string;
  jiraProjectKey: string;
}

function blankDraft(): Draft {
  return {
    name: "",
    cloneUrl: "",
    setupScript: "",
    runScript: "",
    pullIssues: false,
    trackerProvider: "",
    azureProject: "",
    azureAreaPath: "",
    jiraProjectKey: "",
  };
}

function draftFromRepo(r: Repo): Draft {
  const t = r.tracker;
  return {
    id: r.id,
    name: r.name,
    cloneUrl: r.cloneUrl,
    setupScript: r.setupScript ?? "",
    runScript: r.runScript ?? "",
    pullIssues: r.pullIssues,
    trackerProvider: t?.provider ?? "",
    azureProject: t?.provider === "azure-boards" ? t.project : "",
    azureAreaPath: t?.provider === "azure-boards" ? (t.areaPath ?? "") : "",
    jiraProjectKey: t?.provider === "jira" ? t.projectKey : "",
  };
}

/** The tracker a draft describes, or an error naming the missing field. */
function trackerFromDraft(d: Draft): { tracker: RepoTracker | null } | { error: string } {
  switch (d.trackerProvider) {
    case "":
      return { tracker: null };
    case "github":
      return { tracker: { provider: "github" } };
    case "azure-boards": {
      const project = d.azureProject.trim();
      if (!project) return { error: "An Azure Boards project is required." };
      const areaPath = d.azureAreaPath.trim();
      return {
        tracker: { provider: "azure-boards", project, ...(areaPath ? { areaPath } : {}) },
      };
    }
    case "jira": {
      const projectKey = d.jiraProjectKey.trim();
      if (!projectKey) return { error: "A JIRA project key is required." };
      return { tracker: { provider: "jira", projectKey } };
    }
  }
}

function trackerLabel(t: RepoTracker): string {
  switch (t.provider) {
    case "github":
      return "GitHub issues";
    case "azure-boards":
      return `Azure Boards · ${t.project}${t.areaPath ? ` · ${t.areaPath}` : ""}`;
    case "jira":
      return `JIRA · ${t.projectKey}`;
  }
}

/**
 * Manages the repo registry behind Workspaces: the clone URL yarvis pulls from,
 * plus the per-repo setup script (run in each new worktree) and run script
 * (the command that spins up the service). Stored in Postgres via the sidecar.
 */
export default function ReposSection() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRepos(await listRepos());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const beginNew = useCallback(() => {
    setEditingId("new");
    setDraft(blankDraft());
  }, []);

  const beginEdit = useCallback((r: Repo) => {
    setEditingId(r.id);
    setDraft(draftFromRepo(r));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft(blankDraft());
  }, []);

  const saveDraft = useCallback(async () => {
    try {
      if (!draft.cloneUrl.trim()) {
        setError("A clone URL is required.");
        return;
      }
      const tracker = trackerFromDraft(draft);
      if ("error" in tracker) {
        setError(tracker.error);
        return;
      }
      const payload: CreateRepoInput = {
        cloneUrl: draft.cloneUrl.trim(),
        name: draft.name.trim() || undefined,
        setupScript: draft.setupScript.trim() || null,
        runScript: draft.runScript.trim() || null,
        pullIssues: draft.pullIssues,
        tracker: tracker.tracker,
      };
      if (draft.id) {
        await updateRepo(draft.id, payload);
      } else {
        await createRepo(payload);
      }
      // Which repos pull issues decides what the Issues tab may ask for, and
      // that tab is cached across navigation — so its view of this list has to
      // be dropped here rather than waiting for the cache to go stale. Only
      // GitHub's: repo config says nothing about JIRA, or about the stars and
      // links that are keyed by issue rather than by repo.
      invalidatePrefix(GITHUB_ISSUES_PREFIX);
      await refresh();
      setEditingId(null);
      setDraft(blankDraft());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [draft, refresh]);

  const remove = useCallback(
    async (id: string) => {
      if (!confirm("Remove this repo from the registry? Existing clones on disk are left alone.")) {
        return;
      }
      try {
        await deleteRepo(id);
        invalidatePrefix(GITHUB_ISSUES_PREFIX);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const isEditing = editingId !== null;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Repositories</h2>
        {!isEditing && (
          <button
            onClick={beginNew}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Add repo
          </button>
        )}
      </div>
      <p className="mb-4 text-xs text-zinc-500">
        Repos that Workspaces can cut worktrees from. The setup script runs in each new worktree;
        the run script is the command that starts the service for testing.
      </p>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {isEditing && (
        <DraftEditor
          draft={draft}
          setDraft={setDraft}
          onSave={() => void saveDraft()}
          onCancel={cancelEdit}
        />
      )}

      <div className="space-y-3">
        {repos.length === 0 && !isEditing && (
          <p className="text-xs text-zinc-500">No repositories registered.</p>
        )}
        {repos.map((r) =>
          editingId === r.id ? null : (
            <RepoCard
              key={r.id}
              repo={r}
              onEdit={() => beginEdit(r)}
              onDelete={() => void remove(r.id)}
            />
          ),
        )}
      </div>
    </section>
  );
}

function DraftEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (updater: (prev: Draft) => Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mb-5 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label="Clone URL" full>
          <input
            value={draft.cloneUrl}
            placeholder="git@github.com:owner/repo.git"
            onChange={(e) => setDraft((d) => ({ ...d, cloneUrl: e.target.value }))}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
        </Labeled>
        <Labeled label="Display name (optional)" full>
          <input
            value={draft.name}
            placeholder="defaults to the repo name"
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
        </Labeled>
      </div>

      <ScriptEditor
        label="Setup script"
        helper="Runs in each new worktree (e.g. install deps)."
        placeholder="bun install"
        value={draft.setupScript}
        setValue={(v) => setDraft((d) => ({ ...d, setupScript: v }))}
      />
      <ScriptEditor
        label="Run script"
        helper="Command to start the service for testing."
        placeholder="bun run dev"
        value={draft.runScript}
        setValue={(v) => setDraft((d) => ({ ...d, runScript: v }))}
      />

      <label className="mt-4 flex items-start gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={draft.pullIssues}
          onChange={(e) => setDraft((d) => ({ ...d, pullIssues: e.target.checked }))}
          className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-600"
        />
        <span>
          Pull issues
          <span className="mt-0.5 block text-xs text-zinc-500">
            Show this repo's issues in the Issues dashboard.
          </span>
        </span>
      </label>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Labeled label="Tickets go to" full>
          <select
            value={draft.trackerProvider}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                trackerProvider: e.target.value as Draft["trackerProvider"],
              }))
            }
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          >
            <option value="">Not set</option>
            <option value="github">GitHub issues</option>
            <option value="azure-boards">Azure Boards</option>
            <option value="jira">JIRA</option>
          </select>
          <span className="mt-1 block normal-case tracking-normal text-zinc-500">
            Where the assistant files and updates this repo's tickets.
          </span>
        </Labeled>
        {draft.trackerProvider === "azure-boards" && (
          <>
            <Labeled label="Azure project">
              <input
                value={draft.azureProject}
                placeholder="Web"
                onChange={(e) => setDraft((d) => ({ ...d, azureProject: e.target.value }))}
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
              />
            </Labeled>
            <Labeled label="Area path (optional)">
              <input
                value={draft.azureAreaPath}
                placeholder="Web\Payments"
                onChange={(e) => setDraft((d) => ({ ...d, azureAreaPath: e.target.value }))}
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
              />
            </Labeled>
          </>
        )}
        {draft.trackerProvider === "jira" && (
          <Labeled label="JIRA project key">
            <input
              value={draft.jiraProjectKey}
              placeholder="PROJ"
              onChange={(e) => setDraft((d) => ({ ...d, jiraProjectKey: e.target.value }))}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
          </Labeled>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function ScriptEditor({
  label,
  helper,
  placeholder,
  value,
  setValue,
}: {
  label: string;
  helper: string;
  placeholder: string;
  value: string;
  setValue: (v: string) => void;
}) {
  return (
    <div className="mt-4">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <p className="mb-2 text-xs text-zinc-500">{helper}</p>
      <textarea
        value={value}
        placeholder={placeholder}
        rows={3}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-xs outline-none focus:border-zinc-500"
      />
    </div>
  );
}

function Labeled({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block text-xs text-zinc-400 ${full ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

function RepoCard({
  repo,
  onEdit,
  onDelete,
}: {
  repo: Repo;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-zinc-100">{repo.name}</div>
          <div className="text-xs text-zinc-500">
            {repo.owner}/{repo.repo}
            {repo.defaultBranch ? ` · ${repo.defaultBranch}` : ""}
          </div>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={onEdit}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="rounded-md border border-red-900/60 px-2.5 py-1 text-xs text-red-300 hover:bg-red-950/50"
          >
            Delete
          </button>
        </div>
      </div>
      <div className="mt-2 flex gap-3 text-xs text-zinc-500">
        <span>{repo.setupScript ? "setup ✓" : "no setup"}</span>
        <span>{repo.runScript ? "run ✓" : "no run"}</span>
        {repo.pullIssues && <span className="text-indigo-400">issues ✓</span>}
        {repo.tracker && <span>tickets: {trackerLabel(repo.tracker)}</span>}
      </div>
    </div>
  );
}
