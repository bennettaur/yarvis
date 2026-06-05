import type { WorkspaceDetail } from "../../lib/workspaces";

/** Read-only view shown for an archived workspace: summary, merged PR, tasks. */
export default function ArchivedView({ detail }: { detail: WorkspaceDetail }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <p className="text-sm text-zinc-400">
          This workspace is archived. Its worktrees have been removed.
        </p>
        {detail.summary && (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Summary
            </h3>
            <p className="whitespace-pre-wrap text-sm text-zinc-200">{detail.summary}</p>
          </section>
        )}
        {detail.mergedPrUrl && (
          <a
            href={detail.mergedPrUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-sm text-indigo-400 hover:underline"
          >
            {detail.mergedPrUrl}
          </a>
        )}
        {detail.tasks.length > 0 && (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Tasks
            </h3>
            <ul className="space-y-1 text-sm">
              {detail.tasks.map((t) => (
                <li
                  key={t.id}
                  className={t.status === "done" ? "text-emerald-400" : "text-zinc-300"}
                >
                  {t.status === "done" ? "✓" : "○"} {t.title}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
