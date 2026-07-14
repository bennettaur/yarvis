import { useEffect, useState } from "react";
import { listRepos, type Repo } from "../../lib/repos";

/**
 * Repo picker shown when starting work on a JIRA ticket. A JIRA issue isn't tied
 * to a repo, so the user chooses which registered repos the new workspace should
 * include (an empty selection yields a scratch workspace). The last selection is
 * remembered per JIRA project in localStorage, so repeat tickets in the same
 * project pre-select the repos worked last time.
 */
export default function JiraRepoPickerModal({
  projectKey,
  issueKey,
  busy,
  onConfirm,
  onClose,
}: {
  projectKey: string;
  issueKey: string;
  busy: boolean;
  onConfirm: (repoIds: string[]) => void;
  onClose: () => void;
}) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const storageKey = `yarvis:jira-start-repos:${projectKey}`;

  useEffect(() => {
    let live = true;
    listRepos()
      .then((rows) => {
        if (!live) return;
        setRepos(rows);
        // Restore the last repos used for this project, dropping any that have
        // since been removed.
        let savedIds: string[] = [];
        try {
          const raw = localStorage.getItem(storageKey);
          if (raw) savedIds = JSON.parse(raw) as string[];
        } catch {
          savedIds = [];
        }
        setSelected(new Set(savedIds.filter((id) => rows.some((r) => r.id === id))));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [storageKey]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = () => {
    const ids = [...selected];
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {
      // A full/unavailable localStorage shouldn't block starting work.
    }
    onConfirm(ids);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h3 className="text-sm font-medium text-zinc-100">Start work on {issueKey}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-xs text-zinc-500">
            Select the repos to build the workspace from. Leave all unchecked for a scratch
            workspace with no repo.
          </p>
          {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
          {loading ? (
            <p className="text-sm text-zinc-500">Loading repos…</p>
          ) : repos.length === 0 ? (
            <p className="text-sm text-zinc-600">
              No repos registered. Add one in Settings → Repositories, or start a scratch workspace.
            </p>
          ) : (
            <ul className="space-y-1">
              {repos.map((r) => (
                <li key={r.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-800/60">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      className="accent-indigo-500"
                    />
                    <span className="text-zinc-200">{r.name}</span>
                    <span className="text-xs text-zinc-600">
                      {r.owner}/{r.repo}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "Starting…" : selected.size === 0 ? "Start (scratch)" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
