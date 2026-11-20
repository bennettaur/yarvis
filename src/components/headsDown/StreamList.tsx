import { useState } from "react";
import {
  updateWorkStream,
  type WorkStream,
  type WorkStreamLink,
  type WorkStreamPatch,
} from "../../lib/headsDown";
import { requestOpenWorkspace } from "../../lib/nav";
import { openExternal } from "../../lib/url";
import { useWorkspaceNames, type WorkspaceNames } from "../../lib/workspaceMentions";
import WorkspaceMentionText from "../WorkspaceMentionText";

const STATUS_LABEL: Record<WorkStream["status"], string> = {
  active: "Moving",
  "waiting-on-user": "Waiting on you",
  "waiting-on-others": "Waiting on others",
  done: "Done",
  dropped: "Dropped",
};

const STATUS_STYLE: Record<WorkStream["status"], string> = {
  active: "bg-emerald-500/15 text-emerald-300",
  "waiting-on-user": "bg-amber-500/15 text-amber-300",
  "waiting-on-others": "bg-zinc-700/60 text-zinc-300",
  done: "bg-zinc-800 text-zinc-500",
  dropped: "bg-zinc-800 text-zinc-500",
};

/**
 * A link's one-line label: what it is and what was last seen of it. A
 * workspace with no title of its own goes by its current name.
 */
export function linkLabel(link: WorkStreamLink, workspaceNames: WorkspaceNames): string {
  const ref = link.ref;
  const kind =
    ref.kind === "review-request"
      ? `review request, sent ${new Date(ref.sentAt).toLocaleString()}`
      : ref.kind;
  const name =
    link.title ??
    (ref.kind === "ticket"
      ? ref.key
      : ref.kind === "pr"
        ? ref.url
        : ref.kind === "workspace"
          ? (workspaceNames.get(ref.workspaceId.toLowerCase()) ?? null)
          : ref.conversation);
  return `${name ? `${kind}: ${name}` : kind}${link.state ? ` · ${link.state}` : ""}`;
}

/** What clicking a link does, when it goes anywhere. */
function linkAction(link: WorkStreamLink): (() => void) | null {
  const ref = link.ref;
  if (ref.kind === "workspace") return () => requestOpenWorkspace({ id: ref.workspaceId });
  const url = ref.kind === "pr" || ref.kind === "ticket" ? ref.url : undefined;
  return url ? () => openExternal(url) : null;
}

function StreamCard({ stream, onChanged }: { stream: WorkStream; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceNames = useWorkspaceNames();

  const paused = stream.pausedAt !== null;

  const applyPatch = async (patch: WorkStreamPatch) => {
    setBusy(true);
    setError(null);
    try {
      await updateWorkStream(stream.id, patch);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[stream.status]}`}>
              {STATUS_LABEL[stream.status]}
            </span>
            {paused && (
              <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300">
                Paused
              </span>
            )}
            <span className="text-[11px] uppercase text-zinc-500">{stream.priority}</span>
          </div>
          <div className="mt-1 text-sm font-medium text-zinc-100">{stream.title}</div>
        </div>
        <div className="flex shrink-0 gap-2 text-xs">
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyPatch({ paused: !paused })}
            aria-label={`${paused ? "Resume" : "Pause"} ${stream.title}`}
            className="text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyPatch({ status: "done" })}
            aria-label={`Mark ${stream.title} done`}
            className="text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
          >
            Done
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyPatch({ status: "dropped" })}
            aria-label={`Drop ${stream.title}`}
            className="text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
          >
            Drop
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {stream.waitingOn && (
        <p className="mt-1 text-xs text-amber-200/80">
          Waiting on: <WorkspaceMentionText text={stream.waitingOn} names={workspaceNames} />
        </p>
      )}
      {stream.nextAction && (
        <p className="mt-1 text-xs text-zinc-400">
          Next: <WorkspaceMentionText text={stream.nextAction} names={workspaceNames} />
        </p>
      )}
      {stream.wakeAt && new Date(stream.wakeAt) > new Date() && (
        <p className="mt-1 text-xs text-zinc-500">
          Not before {new Date(stream.wakeAt).toLocaleString()}
        </p>
      )}
      {stream.links.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {stream.links.map((link) => {
            const action = linkAction(link);
            const label = linkLabel(link, workspaceNames);
            return (
              <li key={link.id} className="truncate text-xs text-zinc-400">
                {action ? (
                  <button type="button" onClick={action} className="text-left hover:text-zinc-200">
                    {label}
                  </button>
                ) : (
                  label
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** The work streams heads-down mode is pushing, with what each is waiting on. */
export default function StreamList({
  streams,
  loading,
  onChanged,
}: {
  streams: WorkStream[];
  /** Nothing to show yet, so the empty state would be wrong. */
  loading: boolean;
  onChanged: () => void;
}) {
  if (streams.length === 0) {
    if (loading) return <p className="text-sm text-zinc-500">Loading…</p>;
    return (
      <p className="text-sm text-zinc-500">
        Nothing tracked yet. Plan the work in a chat and the assistant tracks each thread here.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {streams.map((stream) => (
        <StreamCard key={stream.id} stream={stream} onChanged={onChanged} />
      ))}
    </ul>
  );
}
