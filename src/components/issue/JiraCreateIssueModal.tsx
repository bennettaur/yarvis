import { useEffect, useState } from "react";
import type { IssueSummary } from "../../lib/issues/types";
import {
  type JiraCreateInput,
  jiraCreateIssue,
  jiraProjectIssueTypes,
  jiraProjects,
} from "../../lib/jira/api";
import type { JiraIssueType, JiraProject } from "../../lib/jira/types";

/**
 * Create-issue dialog: pick a project and issue type, enter a summary and
 * optional description. Issue types are loaded per project (sub-tasks excluded
 * since they can't stand alone). Returns the created issue to the caller so the
 * list can refresh.
 */
export default function JiraCreateIssueModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (issue: IssueSummary) => void;
}) {
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [projectKey, setProjectKey] = useState("");
  const [issueTypes, setIssueTypes] = useState<JiraIssueType[]>([]);
  const [issueTypeName, setIssueTypeName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    jiraProjects()
      .then((rows) => {
        if (!live) return;
        setProjects(rows);
        if (rows[0]) setProjectKey(rows[0].key);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!projectKey) {
      setIssueTypes([]);
      setIssueTypeName("");
      return;
    }
    let live = true;
    jiraProjectIssueTypes(projectKey)
      .then((types) => {
        if (!live) return;
        const usable = types.filter((t) => !t.subtask);
        setIssueTypes(usable);
        setIssueTypeName(usable[0]?.name ?? "");
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [projectKey]);

  const submit = async () => {
    if (!projectKey || !issueTypeName || !summary.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const input: JiraCreateInput = {
        projectKey,
        summary: summary.trim(),
        issueTypeName,
        description: description.trim() || undefined,
      };
      const created = await jiraCreateIssue(input);
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
          <h3 className="text-sm font-medium text-zinc-100">New JIRA issue</h3>
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
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-zinc-400">
              Project
              <select
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value)}
                className={`mt-1 ${inputClass}`}
              >
                {projects.length === 0 && <option value="">Loading…</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex-1 text-xs text-zinc-400">
              Type
              <select
                value={issueTypeName}
                onChange={(e) => setIssueTypeName(e.target.value)}
                className={`mt-1 ${inputClass}`}
              >
                {issueTypes.length === 0 && <option value="">—</option>}
                {issueTypes.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-xs text-zinc-400">
            Summary
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Short summary"
              className={`mt-1 ${inputClass}`}
            />
          </label>
          <label className="block text-xs text-zinc-400">
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={6}
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
            disabled={busy || !projectKey || !issueTypeName || !summary.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
