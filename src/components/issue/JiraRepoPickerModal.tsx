import { useEffect, useMemo, useState } from "react";
import type { JiraTransition, StartWorkChoice } from "../../lib/jira/types";
import { listRepos, type Repo } from "../../lib/repos";

/** The transition to pre-select: prefer a status named "In Progress", then any
 *  in-progress-category status, else none (JIRA's in-progress category also
 *  covers statuses like "Blocked", so name-matching avoids picking those). */
function defaultTransition(transitions: JiraTransition[]): JiraTransition | undefined {
  const inProgress = transitions.filter((t) => t.toStatusCategory === "in_progress");
  return inProgress.find((t) => /in[\s-]?progress/i.test(t.toStatusName)) ?? inProgress[0];
}

/**
 * The Start Work dialog for a JIRA ticket. A JIRA issue isn't tied to a repo, so
 * the user chooses which registered repos the new workspace should include (an
 * empty selection yields a scratch workspace; the last choice is remembered per
 * project). They also choose the target status, since which status means
 * "started" varies per JIRA workflow — it defaults to the in-progress status but
 * can be changed or skipped.
 */
export default function JiraRepoPickerModal({
  projectKey,
  issueKey,
  transitions,
  busy,
  startError,
  onConfirm,
  onClose,
}: {
  projectKey: string;
  issueKey: string;
  transitions: JiraTransition[];
  busy: boolean;
  /** A failed start, shown here because this dialog covers the view behind it. */
  startError: string | null;
  onConfirm: (choice: StartWorkChoice) => void;
  onClose: () => void;
}) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statusChoice, setStatusChoice] = useState<string>("none");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const storageKey = `yarvis:jira-start-repos:${projectKey}`;
  const defaultTransitionId = useMemo(
    () => defaultTransition(transitions)?.id ?? "none",
    [transitions],
  );

  useEffect(() => {
    setStatusChoice(defaultTransitionId);
  }, [defaultTransitionId]);

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
    const transitionToInProgress = statusChoice !== "none";
    onConfirm({
      repoIds: ids,
      transitionToInProgress,
      transitionId: transitionToInProgress ? statusChoice : undefined,
    });
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

          <div className="mt-4 border-t border-zinc-800 pt-3">
            <label className="block text-xs text-zinc-400">
              Move ticket to
              <select
                value={statusChoice}
                onChange={(e) => setStatusChoice(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
              >
                <option value="none">Don’t change status</option>
                {transitions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.toStatusName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          {startError && <p className="mr-auto text-xs text-red-400">{startError}</p>}
          <button
            type="button"
            onClick={onClose}
            // Closing mid-start would drop the dialog while the workspace is
            // still being created, then jump to it anyway when it lands.
            disabled={busy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
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
