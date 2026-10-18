import { useCallback, useState } from "react";
import {
  getHeadsDownConfig,
  getHeadsDownState,
  type HeadsDownConfig,
  type HeadsDownMessage,
  type HeadsDownPass,
  type HeadsDownQuestion,
  type HeadsDownState,
  listHeadsDownMessages,
  listOpenQuestions,
  listPasses,
  listWorkStreams,
  saveHeadsDownConfig,
  sendHeadsDownMessage,
  startHeadsDown,
  stopHeadsDown,
  type WorkStream,
} from "../../lib/headsDown";
import { useCachedResource } from "../../lib/resourceCache";
import HeadsDownSettings from "./HeadsDownSettings";
import PassList from "./PassList";
import QuestionCard from "./QuestionCard";
import StreamList from "./StreamList";
import { useLivePass } from "./useLivePass";

const KEYS = {
  state: "heads-down:state",
  questions: "heads-down:questions",
  streams: "heads-down:streams",
  passes: "heads-down:passes",
  messages: "heads-down:messages",
  config: "heads-down:config",
};

const NO_QUESTIONS: HeadsDownQuestion[] = [];
const NO_STREAMS: WorkStream[] = [];
const NO_PASSES: HeadsDownPass[] = [];
const NO_MESSAGES: HeadsDownMessage[] = [];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

/** Start and stop heads-down mode, and see when it looks next. */
function RunHeader({ state, onChanged }: { state: HeadsDownState | null; onChanged: () => void }) {
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = state?.run ?? null;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setFocus("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      {run ? (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
              Heads down since {new Date(run.startedAt).toLocaleString()}
            </div>
            {run.focus && <p className="mt-1 text-sm text-zinc-300">{run.focus}</p>}
            <p className="mt-1 text-xs text-zinc-500">
              {state?.nextPassAt
                ? `Next look ${new Date(state.nextPassAt).toLocaleTimeString()}`
                : "Starting its first pass"}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(stopHeadsDown)}
            className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Stop
          </button>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => startHeadsDown(focus.trim()));
          }}
        >
          <p className="text-sm text-zinc-300">
            Heads-down mode keeps your work streams moving while you focus elsewhere. It starts work
            on tickets, chases CI and reviews, and asks you only what it has to.
          </p>
          <div className="flex gap-2">
            <input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="What should it push on? (optional)"
              aria-label="Focus"
              className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              Go heads down
            </button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** A message the next pass reads: direction, new work, a standing instruction. */
function MessageBox({ messages, onSent }: { messages: HeadsDownMessage[]; onSent: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await sendHeadsDownMessage(body.trim());
      setBody("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="e.g. When Alex asks if the billing PR is ready, send him the link"
        aria-label="Message for heads-down mode"
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !body.trim()}
          onClick={() => void send()}
          className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          Send
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      {messages.length > 0 && (
        <ul className="space-y-1">
          {messages.slice(0, 10).map((m) => (
            <li key={m.id} className="text-xs text-zinc-400">
              <span className="text-zinc-500">
                {new Date(m.createdAt).toLocaleString()} · {m.seenAt ? "read" : "not read yet"}
              </span>
              <p className="whitespace-pre-wrap text-zinc-300">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The Heads down page: what heads-down mode is working on, what it needs from
 * the user, what it has done, and a place to tell it things. The user can keep
 * chatting with the assistant elsewhere while this runs.
 */
export default function HeadsDownPanel() {
  const state = useCachedResource<HeadsDownState>(KEYS.state, getHeadsDownState);
  const questions = useCachedResource<HeadsDownQuestion[]>(KEYS.questions, listOpenQuestions);
  const streams = useCachedResource<WorkStream[]>(KEYS.streams, listWorkStreams);
  const passes = useCachedResource<HeadsDownPass[]>(KEYS.passes, listPasses);
  const messages = useCachedResource<HeadsDownMessage[]>(KEYS.messages, listHeadsDownMessages);
  const config = useCachedResource<HeadsDownConfig>(KEYS.config, getHeadsDownConfig);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshAll = useCallback(() => {
    void state.refresh();
    void questions.refresh();
    void streams.refresh();
    void passes.refresh();
    void messages.refresh();
  }, [state, questions, streams, passes, messages]);
  const live = useLivePass(refreshAll);

  const open = questions.data ?? NO_QUESTIONS;

  const allowTool = useCallback(
    async (toolId: string) => {
      const current = config.data ?? (await getHeadsDownConfig());
      if (current.unattendedMcpTools.includes(toolId)) return;
      await saveHeadsDownConfig({
        ...current,
        unattendedMcpTools: [...current.unattendedMcpTools, toolId],
      });
      await config.refresh();
    },
    [config],
  );

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-6">
        <RunHeader state={state.data} onChanged={refreshAll} />

        {open.length > 0 && (
          <Section title={`Needs you (${open.length})`}>
            {open.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                onAnswered={refreshAll}
                onAllowTool={allowTool}
              />
            ))}
          </Section>
        )}

        <Section title="Work streams">
          <StreamList streams={streams.data ?? NO_STREAMS} onChanged={refreshAll} />
        </Section>

        <Section title="What it has been doing">
          <PassList passes={passes.data ?? NO_PASSES} live={live} />
        </Section>
      </div>

      <aside className="space-y-6">
        <Section title="Tell it something">
          <MessageBox messages={messages.data ?? NO_MESSAGES} onSent={refreshAll} />
        </Section>

        <Section title="Pace and working hours">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            className="text-sm text-zinc-400 hover:text-zinc-200"
          >
            {settingsOpen ? "Hide" : "Show"} settings
          </button>
          {settingsOpen && config.data && (
            <HeadsDownSettings config={config.data} onSaved={() => void config.refresh()} />
          )}
        </Section>
      </aside>
    </div>
  );
}
