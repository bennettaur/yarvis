import { useState } from "react";
import { getPass, type HeadsDownPass, type PassMessage } from "../../lib/headsDown";
import Markdown from "../Markdown";
import TurnActivity from "../TurnActivity";
import type { LivePass } from "./useLivePass";

function describeSleep(pass: HeadsDownPass): string | null {
  if (pass.sleepMinutes === null) return null;
  return `then slept ${pass.sleepMinutes} min${pass.sleepReason ? ` (${pass.sleepReason})` : ""}`;
}

/** One finished pass: a summary line, and its transcript one click away. */
function PassRow({ pass }: { pass: HeadsDownPass }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<PassMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && messages === null) {
      try {
        setMessages((await getPass(pass.id)).messages);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  // The first message is the prompt the pass started from; the rest is what it did.
  const replies = messages?.filter((m) => m.role === "assistant") ?? [];

  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
      >
        <div className="min-w-0">
          <div className="text-sm text-zinc-200">
            {new Date(pass.startedAt).toLocaleString()}
            {pass.error && <span className="ml-2 text-xs text-red-400">failed</span>}
          </div>
          {pass.notes && <p className="mt-0.5 text-xs text-zinc-400">{pass.notes}</p>}
          {pass.error && <p className="mt-0.5 text-xs text-red-300/80">{pass.error}</p>}
        </div>
        <span className="shrink-0 text-xs text-zinc-500">{describeSleep(pass)}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800 px-3 py-2">
          {error && <p className="text-xs text-red-400">{error}</p>}
          {messages === null && !error && <p className="text-xs text-zinc-500">Loading…</p>}
          {messages !== null && replies.length === 0 && (
            <p className="text-xs text-zinc-500">Nothing recorded for this pass.</p>
          )}
          {replies.map((m) => (
            <div key={m.id}>
              <TurnActivity activity={m.toolCalls ?? []} />
              {m.content && <Markdown className="text-sm text-zinc-200">{m.content}</Markdown>}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/** What heads-down mode has been doing: the pass in flight, live, and the ones before it. */
export default function PassList({
  passes,
  live,
}: {
  passes: HeadsDownPass[];
  live: LivePass | null;
}) {
  const finished = passes.filter((p) => p.finishedAt !== null);
  return (
    <div className="space-y-2">
      {live && (
        <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-3">
          <div className="mb-2 text-xs font-medium text-indigo-300">Working now</div>
          <TurnActivity activity={live.activity} thinking={live.thinking || undefined} running />
          {live.text && <Markdown className="text-sm text-zinc-200">{live.text}</Markdown>}
        </div>
      )}
      {finished.length === 0 && !live ? (
        <p className="text-sm text-zinc-500">No passes yet.</p>
      ) : (
        <ul className="space-y-2">
          {finished.map((pass) => (
            <PassRow key={pass.id} pass={pass} />
          ))}
        </ul>
      )}
    </div>
  );
}
