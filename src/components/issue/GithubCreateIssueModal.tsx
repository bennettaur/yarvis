import { useState } from "react";
import { createIssue } from "../../lib/issues/api";
import type { IssueRepo, IssueSummary } from "../../lib/issues/types";

/**
 * Create-issue dialog for GitHub: pick one of the repos configured to pull
 * issues, enter a title and optional description. Returns the created issue to
 * the caller so it can open or refresh it.
 */
export default function GithubCreateIssueModal({
  repos,
  onClose,
  onCreated,
}: {
  repos: IssueRepo[];
  onClose: () => void;
  onCreated: (issue: IssueSummary) => void;
}) {
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repo = repos.find((r) => r.id === repoId);

  const submit = async () => {
    if (!repo || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createIssue(repo.owner, repo.repo, {
        title: title.trim(),
        body: body.trim(),
      });
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const inputClass =
    "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h3 className="text-sm font-medium text-zinc-100">New GitHub issue</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {error && <p className="text-xs text-red-400">{error}</p>}
          <label className="block text-xs text-zinc-400">
            Repository
            <select
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className={`mt-1 ${inputClass}`}
            >
              {repos.length === 0 && <option value="">No repos pull issues</option>}
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.owner}/{r.repo}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-zinc-400">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short title"
              className={`mt-1 ${inputClass}`}
            />
          </label>
          <label className="block text-xs text-zinc-400">
            Description
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Optional description (Markdown)"
              rows={8}
              className={`mt-1 ${inputClass}`}
            />
          </label>
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
            onClick={() => void submit()}
            disabled={busy || !repo || !title.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
