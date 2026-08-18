import { type ReactNode, useEffect, useState } from "react";
import { requestOpenPr } from "../../lib/nav";
import type { PrSummary } from "../../lib/pr/types";
import { repoPrRef } from "../../lib/repos";
import { openExternal } from "../../lib/url";
import {
  type CheckRollup,
  type WorkspaceRepoDetail,
  type WorkspaceRepoSync,
  workspaceRepoSync,
} from "../../lib/workspaces";
import CopyButton from "../CopyButton";

const ROLLUP_LABEL: Record<CheckRollup, string> = {
  success: "✓ checks passing",
  failure: "✗ checks failing",
  pending: "● checks running",
  none: "no checks",
};
const ROLLUP_COLOR: Record<CheckRollup, string> = {
  success: "text-emerald-400",
  failure: "text-red-400",
  pending: "text-amber-400",
  none: "text-zinc-500",
};

const PR_STATE_STYLES: Record<string, string> = {
  open: "bg-emerald-900/40 text-emerald-200",
  merged: "bg-violet-900/60 text-violet-200",
  closed: "bg-zinc-800 text-zinc-400",
};

/**
 * True when the cached mergeable value signals conflicts against the base.
 * GitHub reports "dirty" (its `mergeable_state`); Azure reports "CONFLICTING"
 * (the shared enum the poller stores), which older GitHub GraphQL rows also
 * used — so match either, case-insensitively.
 */
function hasConflicts(mergeable: string | null): boolean {
  const m = (mergeable ?? "").toLowerCase();
  return m === "dirty" || m === "conflicting";
}

/** Builds the minimal PrSummary the in-app review needs from the poller cache. */
function buildPrSummary(repo: WorkspaceRepoDetail): PrSummary | null {
  const pr = repo.pr;
  if (!pr?.prNumber || !pr.prUrl) return null;
  return {
    ref: repoPrRef(repo.repo, pr.prNumber),
    title: "",
    url: pr.prUrl,
    author: "",
    draft: pr.isDraft ?? false,
    state: pr.prState ?? "open",
    createdAt: "",
    updatedAt: "",
  };
}

/** How often the push/pull sync refreshes. Each tick does a git fetch, so this
 *  is deliberately slower than the file/changes polling. */
const SYNC_REFRESH_INTERVAL_MS = 30_000;

/** Polls a workspace repo's push/pull divergence, pausing while hidden. */
function useRepoSync(workspaceId: string, workspaceRepoId: string): WorkspaceRepoSync | null {
  const [sync, setSync] = useState<WorkspaceRepoSync | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const next = await workspaceRepoSync(workspaceId, workspaceRepoId);
        if (live) setSync(next);
      } catch {
        // Leave the last-known counts in place on a transient failure.
      } finally {
        if (live && !document.hidden) timer = setTimeout(tick, SYNC_REFRESH_INTERVAL_MS);
      }
    };
    const onVisibility = () => {
      if (!document.hidden && live && timer === null) void tick();
    };

    setSync(null);
    void tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workspaceId, workspaceRepoId]);

  return sync;
}

/**
 * Push/pull chips. Pull is surfaced first and highlighted — the priority when
 * both directions have work — covering both remote-branch commits and a base
 * that has moved on. Renders nothing when the branch is fully in sync.
 */
function SyncChips({ sync }: { sync: WorkspaceRepoSync }) {
  const pull = sync.behind + sync.baseBehind;
  const chips: ReactNode[] = [];
  if (pull > 0) {
    const label =
      sync.baseBehind > 0 && sync.behind > 0
        ? `↓ ${sync.behind} to pull · base +${sync.baseBehind}`
        : sync.baseBehind > 0
          ? `↓ base moved +${sync.baseBehind}`
          : `↓ ${sync.behind} to pull`;
    chips.push(
      <span key="pull" className="rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-200">
        {label}
      </span>,
    );
  }
  if (sync.ahead > 0) {
    chips.push(
      <span key="push" className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
        ↑ {sync.ahead} to {sync.hasRemote ? "push" : "push (new branch)"}
      </span>,
    );
  }
  if (chips.length === 0) return null;
  return <span className="flex items-center gap-1.5">{chips}</span>;
}

/**
 * A prominent, always-visible PR + branch status line for one workspace repo:
 * PR state, check rollup, merge-conflict warning, and push/pull divergence —
 * surfaced on the workspace page rather than hidden inside the side-panel tab.
 */
export default function WorkspacePrStatus({
  workspaceId,
  repo,
  showRepoName,
}: {
  workspaceId: string;
  repo: WorkspaceRepoDetail;
  /** Prefix the row with the repo name (for multi-repo workspaces). */
  showRepoName: boolean;
}) {
  const sync = useRepoSync(workspaceId, repo.id);
  const pr = repo.pr;
  const summary = buildPrSummary(repo);
  const conflicts = hasConflicts(pr?.mergeable ?? null);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {showRepoName && <span className="font-medium text-zinc-300">{repo.repo.name}</span>}

      {pr?.prNumber ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-zinc-400">#{pr.prNumber}</span>
            <span
              className={`rounded px-1.5 py-0.5 ${PR_STATE_STYLES[pr.prState ?? "open"] ?? "bg-zinc-800 text-zinc-300"}`}
            >
              {pr.prState ?? "open"}
            </span>
            {pr.isDraft && (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">draft</span>
            )}
          </span>
          <span className={ROLLUP_COLOR[pr.checkRollup]}>{ROLLUP_LABEL[pr.checkRollup]}</span>
          {conflicts && (
            <span className="rounded bg-red-900/50 px-1.5 py-0.5 text-red-200">
              ⚠ merge conflicts
            </span>
          )}
        </>
      ) : (
        <span className="text-zinc-500">
          {pr && pr.lastPolledAt !== null ? "No PR yet" : "PR not polled yet"}
        </span>
      )}

      {sync && <SyncChips sync={sync} />}

      {summary && (
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => requestOpenPr(summary)}
            className="rounded border border-indigo-700/60 bg-indigo-900/30 px-1.5 py-0.5 text-indigo-200 hover:bg-indigo-900/60"
          >
            Review
          </button>
          <button
            type="button"
            onClick={() => pr?.prUrl && openExternal(pr.prUrl)}
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
          >
            Open ↗
          </button>
          <CopyButton value={summary.url} subject="PR link" />
        </span>
      )}
    </div>
  );
}
