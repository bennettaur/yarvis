import { useState } from "react";
import { getPass, type HeadsDownPass, type PassMessage } from "../../lib/headsDown";
import Markdown from "../Markdown";
import TurnActivity from "../TurnActivity";
import AgentMark from "./AgentMark";
import type { LivePass } from "./useLivePass";

/** The sleep reason the sidecar records for a pass the user stopped (`headsDown/pass.ts`). */
const STOPPED_BY_USER = "stopped by you";

function describeSleep(pass: HeadsDownPass): string | null {
  if (pass.sleepReason === STOPPED_BY_USER) return "Stopped by you";
  if (pass.sleepMinutes === null) return null;
  return `Then slept ${pass.sleepMinutes} min${pass.sleepReason ? ` (${pass.sleepReason})` : ""}`;
}

function describeCalls(pass: HeadsDownPass): string | null {
  if (!pass.calls) return null;
  const failed = pass.failedCalls?.length ?? 0;
  return `${pass.calls} tool call${pass.calls === 1 ? "" : "s"}${failed > 0 ? ` · ${failed} failed` : ""}`;
}

/** One finished pass: what it left, how it ended, and its transcript one click away. */
function PassRow({ pass }: { pass: HeadsDownPass }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<PassMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !isOpen;
    setIsOpen(next);
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
  const sleep = describeSleep(pass);
  const calls = describeCalls(pass);
  const failedCalls = pass.failedCalls ?? [];

  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={isOpen}
        className="w-full px-3 py-2 text-left"
      >
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-zinc-200">
          <span>{new Date(pass.startedAt).toLocaleString()}</span>
          {pass.error && <span className="text-xs text-red-400">failed</span>}
          {calls && <span className="text-xs text-zinc-500">{calls}</span>}
        </div>
        {sleep && <p className="mt-0.5 text-xs text-zinc-500">{sleep}</p>}
      </button>
      {(pass.notes || pass.error || failedCalls.length > 0) && (
        <div className="space-y-1 px-3 pb-2">
          {pass.notes && <Markdown className="text-xs text-zinc-400">{pass.notes}</Markdown>}
          {pass.error && <p className="text-xs text-red-300/80">{pass.error}</p>}
          {failedCalls.length > 0 && (
            <ul className="space-y-0.5 text-xs text-zinc-500">
              {failedCalls.map((call, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the same call can fail twice, and the list never reorders
                <li key={i} className="break-words">
                  <span className="text-red-400">✕</span> {call.server ? `${call.server}/` : ""}
                  {call.name}
                  {call.error ? `: ${call.error}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {isOpen && (
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

/** The latest thing the pass thought, folded to one line until opened. */
function LatestThought({ text, thinking }: { text: string; thinking: boolean }) {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return (
    <details className="group mb-2 rounded-md border border-zinc-800 bg-zinc-900/60 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-zinc-400 hover:text-zinc-200">
        <span className="shrink-0 transition-transform group-open:rotate-90">›</span>
        <span className={`shrink-0 ${thinking ? "animate-pulse motion-reduce:animate-none" : ""}`}>
          {thinking ? "Thinking:" : "Last thought:"}
        </span>
        <span className="truncate group-open:hidden">{firstLine}</span>
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-2 pb-2 text-zinc-400">
        {text}
      </pre>
    </details>
  );
}

/** What heads-down mode has been doing: the pass in flight, live, and the ones before it. */
export default function PassList({
  passes,
  live,
  loading,
}: {
  passes: HeadsDownPass[];
  live: LivePass | null;
  /** Nothing to show yet, so the empty state would be wrong. */
  loading: boolean;
}) {
  const finished = passes.filter((p) => p.finishedAt !== null);
  return (
    <div className="space-y-2">
      {live && (
        <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-indigo-300">
            <AgentMark state="working" className="h-5 w-5" />
            Working now
            {live.activity.length > 0 && (
              <span className="font-normal text-zinc-500">
                · {live.activity.length} tool call{live.activity.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {live.error && (
            <p className="mb-2 text-xs text-amber-300">
              The model provider failed: {live.error}. It tries again if the error looks temporary.
            </p>
          )}
          {live.thought && <LatestThought text={live.thought} thinking={live.thinking} />}
          <TurnActivity activity={live.activity} running />
          {live.text && <Markdown className="text-sm text-zinc-200">{live.text}</Markdown>}
        </div>
      )}
      {finished.length === 0 && !live ? (
        <p className="text-sm text-zinc-500">{loading ? "Loading…" : "No passes yet."}</p>
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
