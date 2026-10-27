import type { ReviewCommit } from "../../../lib/reviewWorkspaces/sinceReview";
import { formatRelativeTime } from "../../../lib/time";
import type { TabSpec } from "../tabs/types";

/**
 * The PR's commits in the left nav, newest first. Each opens as a commit tab;
 * the ones new since the last review are marked, so "what's new" reads at a
 * glance without opening anything.
 */
export default function CommitsList({
  prId,
  commits,
  truncated,
  activeSha,
  openTab,
}: {
  prId: string;
  commits: ReviewCommit[];
  truncated: boolean;
  activeSha: string | null;
  openTab: (spec: TabSpec) => void;
}) {
  if (commits.length === 0) return <p className="px-3 py-1 text-xs text-zinc-500">No commits.</p>;
  return (
    <ul aria-label="Commits">
      {commits.map((c) => (
        <li key={c.sha}>
          <button
            type="button"
            onClick={() => openTab({ kind: "commit", prId, sha: c.sha, subject: c.subject })}
            title={`${c.sha}\n${c.subject}\n${c.author} · ${formatRelativeTime(c.date)}${
              c.isNew ? "\nNew since your last review" : ""
            }`}
            className={`flex w-full items-center gap-1.5 px-3 py-0.5 text-left text-xs ${
              activeSha === c.sha
                ? "bg-zinc-800 text-zinc-100"
                : c.isNew
                  ? "text-zinc-100 hover:bg-zinc-800/60"
                  : "text-zinc-400 hover:bg-zinc-800/60"
            }`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.isNew ? "bg-emerald-400" : "bg-transparent"}`}
            />
            <span className="shrink-0 font-mono text-zinc-500">{c.sha.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate">{c.subject}</span>
            {c.isNew && <span className="sr-only">new since your last review</span>}
          </button>
        </li>
      ))}
      {truncated && <li className="px-3 py-0.5 text-xs text-zinc-500">Older commits not shown.</li>}
    </ul>
  );
}
