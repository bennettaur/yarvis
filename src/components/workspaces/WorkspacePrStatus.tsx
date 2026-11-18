import { type ReactNode, useEffect, useState } from "react";
import { requestOpenPr } from "../../lib/nav";
import type { PrSummary } from "../../lib/pr/types";
import { hasConflicts } from "../../lib/prGlance";
import { repoPrRef } from "../../lib/repos";
import { openExternal } from "../../lib/url";
import {
  type CheckRollup,
  type DetectedPrs,
  detectWorkspacePrs,
  linkWorkspacePr,
  unlinkWorkspacePr,
  type WorkspaceRepoDetail,
  type WorkspaceRepoPr,
  type WorkspaceRepoSync,
  workspaceRepoSync,
} from "../../lib/workspaces";
import CopyLinkButton from "../CopyLinkButton";

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

/** Builds the minimal PrSummary the in-app review needs from the poller cache. */
function buildPrSummary(repo: WorkspaceRepoDetail, pr: WorkspaceRepoPr): PrSummary | null {
  if (!pr.prNumber || !pr.prUrl) return null;
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

/** One line on what detection found, for the note beside its button. */
function summarizeDetection(found: DetectedPrs[]): { text: string; failed: boolean } {
  // The button only shows beside ready repos, and the sidecar leaves out a
  // repo no configured provider can read, so an empty answer means no token.
  if (found.length === 0) {
    return { text: "No GitHub or Azure DevOps token can read these repos", failed: true };
  }
  const count = found.reduce((n, repo) => n + repo.prs.length, 0);
  return {
    text: count ? `Found ${count} PR${count === 1 ? "" : "s"}` : "No PR found",
    failed: false,
  };
}

/**
 * Searches every repo's branches for PRs now, rather than on the poller's
 * schedule, and adds what it finds. Reports what it found, or why it couldn't.
 */
export function DetectPrsButton({
  workspaceId,
  onDetected,
}: {
  workspaceId: string;
  onDetected: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);

  const detect = async () => {
    setBusy(true);
    setNote(null);
    try {
      setNote(summarizeDetection(await detectWorkspacePrs(workspaceId)));
      onDetected();
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), failed: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={() => void detect()}
        disabled={busy}
        title="Search every branch in this workspace for pull requests now"
        className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
      >
        {busy ? "Detecting…" : "Detect PRs again"}
      </button>
      {note && (
        <span role="status" className={note.failed ? "text-red-400" : "text-zinc-500"}>
          {note.text}
        </span>
      )}
    </span>
  );
}

/**
 * Links a PR by number, for one that isn't on the worktree's branch or that
 * detection missed. Collapsed to a button until asked for.
 */
function LinkPrControl({
  workspaceId,
  repo,
  onLinked,
}: {
  workspaceId: string;
  repo: WorkspaceRepoDetail;
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Link a pull request to ${repo.repo.name} by its number`}
        className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800"
      >
        Link PR
      </button>
    );
  }

  const number = Number(value.trim().replace(/^#/, ""));
  const valid = Number.isInteger(number) && number > 0;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await linkWorkspacePr(workspaceId, repo.id, number);
      setOpen(false);
      setValue("");
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: opened by an explicit click, to type straight away
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="PR #"
        aria-label={`Pull request number for ${repo.repo.name}`}
        className="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-zinc-200"
      />
      <button
        type="submit"
        disabled={!valid || busy}
        className="rounded border border-indigo-700/60 bg-indigo-900/30 px-1.5 py-0.5 text-indigo-200 hover:bg-indigo-900/60 disabled:opacity-50"
      >
        {busy ? "Linking…" : "Link"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="px-1 py-0.5 text-zinc-500 hover:text-zinc-300"
      >
        Cancel
      </button>
      {error && (
        <span role="alert" className="text-red-400">
          {error}
        </span>
      )}
    </form>
  );
}

/** One linked PR: its state and checks, and buttons to review, open, copy or unlink it. */
function PrRow({
  workspaceId,
  repo,
  pr,
  onChanged,
}: {
  workspaceId: string;
  repo: WorkspaceRepoDetail;
  pr: WorkspaceRepoPr;
  onChanged: () => void;
}) {
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = buildPrSummary(repo, pr);
  const conflicts = hasConflicts(pr.mergeable);
  const number = pr.prNumber;
  if (number === null) return null;
  // Named only when it isn't the worktree's own branch, such as a stack layer.
  const otherBranch = pr.headBranch && pr.headBranch !== repo.branch ? pr.headBranch : null;

  const unlink = async () => {
    setUnlinking(true);
    setError(null);
    try {
      await unlinkWorkspacePr(workspaceId, repo.id, number);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setUnlinking(false);
    }
  };

  return (
    <div
      data-testid="workspace-pr"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${pr.prState === "closed" ? "opacity-60" : ""}`}
    >
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-zinc-400">#{number}</span>
        <span
          className={`rounded px-1.5 py-0.5 ${PR_STATE_STYLES[pr.prState ?? "open"] ?? "bg-zinc-800 text-zinc-300"}`}
        >
          {pr.prState ?? "open"}
        </span>
        {pr.isDraft && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">draft</span>
        )}
        {otherBranch && <span className="font-mono text-zinc-500">{otherBranch}</span>}
      </span>
      <span className={ROLLUP_COLOR[pr.checkRollup]}>{ROLLUP_LABEL[pr.checkRollup]}</span>
      {conflicts && (
        <span className="rounded bg-red-900/50 px-1.5 py-0.5 text-red-200">⚠ merge conflicts</span>
      )}
      <span className="flex items-center gap-1.5">
        {summary && (
          <>
            <button
              type="button"
              onClick={() => requestOpenPr(summary)}
              className="rounded border border-indigo-700/60 bg-indigo-900/30 px-1.5 py-0.5 text-indigo-200 hover:bg-indigo-900/60"
            >
              Review
            </button>
            <button
              type="button"
              onClick={() => pr.prUrl && openExternal(pr.prUrl)}
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
            >
              Open ↗
            </button>
            <CopyLinkButton
              url={summary.url}
              subject="PR link"
              title={`Copy the link to ${repo.repo.name} #${number}`}
            />
          </>
        )}
        <button
          type="button"
          onClick={() => void unlink()}
          disabled={unlinking}
          title={`Stop showing #${number} in this workspace. Searching its branches won't add it back.`}
          className="px-1 py-0.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
        >
          Unlink
        </button>
      </span>
      {error && (
        <span role="alert" className="text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * A prominent, always-visible PR + branch status block for one workspace repo:
 * every PR linked to it with its state, checks and merge conflicts, and the
 * branch's push/pull divergence — surfaced on the workspace page rather than
 * hidden inside the side-panel tab.
 */
export default function WorkspacePrStatus({
  workspaceId,
  repo,
  showRepoName,
  onPrLinked,
}: {
  workspaceId: string;
  repo: WorkspaceRepoDetail;
  /** Prefix the block with the repo name (for multi-repo workspaces). */
  showRepoName: boolean;
  /** Called after a PR is linked or unlinked, to re-read the workspace. */
  onPrLinked: () => void;
}) {
  const sync = useRepoSync(workspaceId, repo.id);

  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {showRepoName && <span className="font-medium text-zinc-300">{repo.repo.name}</span>}
        {repo.prs.length === 0 && (
          <span className="text-zinc-500">
            {repo.prsPolledAt ? "No PR yet" : "PR not polled yet"}
          </span>
        )}
        {sync && <SyncChips sync={sync} />}
        <LinkPrControl workspaceId={workspaceId} repo={repo} onLinked={onPrLinked} />
      </div>
      {repo.prs.map((pr) => (
        <PrRow
          key={pr.prNumber}
          workspaceId={workspaceId}
          repo={repo}
          pr={pr}
          onChanged={onPrLinked}
        />
      ))}
    </div>
  );
}
