import { updateWorkStream, type WorkStream, type WorkStreamLink } from "../../lib/headsDown";

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

/** A link's one-line label: what it is and what was last seen of it. */
export function linkLabel(link: WorkStreamLink): string {
  const ref = link.ref;
  const name =
    link.title ??
    (ref.kind === "ticket"
      ? ref.key
      : ref.kind === "pr"
        ? ref.url
        : ref.kind === "workspace"
          ? "workspace"
          : ref.conversation);
  const kind =
    ref.kind === "review-request"
      ? `review request, sent ${new Date(ref.sentAt).toLocaleString()}`
      : ref.kind;
  return `${kind}: ${name}${link.state ? ` · ${link.state}` : ""}`;
}

/** The web address a link opens, when it has one. */
function linkUrl(link: WorkStreamLink): string | null {
  const ref = link.ref;
  const url = ref.kind === "pr" ? ref.url : ref.kind === "ticket" ? ref.url : null;
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** The work streams heads-down mode is pushing, with what each is waiting on. */
export default function StreamList({
  streams,
  onChanged,
}: {
  streams: WorkStream[];
  onChanged: () => void;
}) {
  if (streams.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Nothing tracked yet. Plan the work in a chat and the assistant tracks each thread here.
      </p>
    );
  }

  const close = async (stream: WorkStream, status: "done" | "dropped") => {
    await updateWorkStream(stream.id, { status });
    onChanged();
  };

  return (
    <ul className="space-y-2">
      {streams.map((stream) => (
        <li key={stream.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[stream.status]}`}
                >
                  {STATUS_LABEL[stream.status]}
                </span>
                <span className="text-[11px] uppercase text-zinc-500">{stream.priority}</span>
              </div>
              <div className="mt-1 text-sm font-medium text-zinc-100">{stream.title}</div>
            </div>
            <div className="flex shrink-0 gap-2 text-xs">
              <button
                type="button"
                onClick={() => void close(stream, "done")}
                className="text-zinc-500 hover:text-zinc-200"
              >
                Done
              </button>
              <button
                type="button"
                onClick={() => void close(stream, "dropped")}
                className="text-zinc-500 hover:text-zinc-200"
              >
                Drop
              </button>
            </div>
          </div>
          {stream.waitingOn && (
            <p className="mt-1 text-xs text-amber-200/80">Waiting on: {stream.waitingOn}</p>
          )}
          {stream.nextAction && (
            <p className="mt-1 text-xs text-zinc-400">Next: {stream.nextAction}</p>
          )}
          {stream.wakeAt && new Date(stream.wakeAt) > new Date() && (
            <p className="mt-1 text-xs text-zinc-500">
              Not before {new Date(stream.wakeAt).toLocaleString()}
            </p>
          )}
          {stream.links.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {stream.links.map((link) => {
                const url = linkUrl(link);
                return (
                  <li key={link.id} className="truncate text-xs text-zinc-400">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-zinc-200"
                      >
                        {linkLabel(link)}
                      </a>
                    ) : (
                      linkLabel(link)
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
