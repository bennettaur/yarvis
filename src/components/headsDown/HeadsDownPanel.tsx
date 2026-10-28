import { useCallback, useState } from "react";
import {
  type AllowedTool,
  clearHeadsDown,
  getHeadsDownConfig,
  getHeadsDownState,
  type HeadsDownConfig,
  type HeadsDownMessage,
  type HeadsDownPass,
  type HeadsDownQuestion,
  type HeadsDownRun,
  type HeadsDownState,
  listAllowedTools,
  listAutoApprovals,
  listHeadsDownMessages,
  listOpenQuestions,
  listPasses,
  listWorkStreams,
  nextOccurrence,
  pauseHeadsDown,
  resumeHeadsDown,
  sendHeadsDownMessage,
  setHeadsDownStopAt,
  setToolAllowed,
  startHeadsDown,
  stopHeadsDown,
  type WorkStream,
} from "../../lib/headsDown";
import { combineResources, useCachedResource } from "../../lib/resourceCache";
import RefreshingIndicator from "../RefreshingIndicator";
import AgentMark, { type AgentState } from "./AgentMark";
import AutoApprovals from "./AutoApprovals";
import HeadsDownSettings from "./HeadsDownSettings";
import PassList from "./PassList";
import QuestionCard from "./QuestionCard";
import StreamList from "./StreamList";
import { useLivePass } from "./useLivePass";

const CACHE_KEYS = {
  state: "heads-down:state",
  questions: "heads-down:questions",
  streams: "heads-down:streams",
  passes: "heads-down:passes",
  messages: "heads-down:messages",
  config: "heads-down:config",
  allowedTools: "heads-down:allowed-tools",
  autoApprovals: "heads-down:auto-approvals",
};

const NO_QUESTIONS: HeadsDownQuestion[] = [];
const NO_STREAMS: WorkStream[] = [];
const NO_PASSES: HeadsDownPass[] = [];
const NO_MESSAGES: HeadsDownMessage[] = [];
const NO_TOOLS: AllowedTool[] = [];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Starts heads-down mode over by dropping its work streams and messages. Asks
 * once more before doing it, since dropped streams leave the page.
 */
function ClearButton({ disabled, onClear }: { disabled: boolean; onClear: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setConfirming(true)}
        title="Drop every open work stream and delete your messages, so the next run starts fresh"
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
      >
        Clear old work
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400">
      <span>Drop all open work streams and messages?</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setConfirming(false);
          onClear();
        }}
        className="rounded-md bg-red-600/80 px-2 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
      >
        Yes, clear
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-zinc-400 hover:text-zinc-200"
      >
        Cancel
      </button>
    </div>
  );
}

/** When the run stops on its own, and a way to set, change or clear it. */
function StopTime({
  stopAt,
  disabled,
  onSet,
}: {
  stopAt: string | null;
  disabled: boolean;
  onSet: (stopAt: string | null) => void;
}) {
  const [time, setTime] = useState("");
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
      <span>
        {stopAt ? `Stops at ${new Date(stopAt).toLocaleString()}` : "Runs until you stop it"}
      </span>
      <input
        type="time"
        value={time}
        onChange={(e) => setTime(e.target.value)}
        aria-label="Stop at"
        className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300"
      />
      <button
        type="button"
        disabled={disabled || !time}
        onClick={() => {
          onSet(nextOccurrence(time));
          setTime("");
        }}
        className="text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
      >
        {stopAt ? "Change" : "Set stop time"}
      </button>
      {stopAt && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSet(null)}
          className="text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** The header's line about what happens next: paused, working, or when it looks again. */
function describeNextPass(state: HeadsDownState, run: HeadsDownRun, working: boolean): string {
  if (run.pausedAt !== null)
    return "No passes until you resume it. Its streams and questions are kept.";
  if (working) return "Working now";
  if (state.nextPassAt) return `Sleeping until ${new Date(state.nextPassAt).toLocaleTimeString()}`;
  // The sidecar leaves out a next pass that would come after the stop time.
  if (state.lastPass && run.stopAt) return "No more passes before it stops";
  return "Starting its first pass";
}

/** Start, pause and stop heads-down mode, and see when it runs next and when it stops. */
function RunHeader({
  state,
  working,
  onChanged,
}: {
  /** Null while the first load is in flight. */
  state: HeadsDownState | null;
  /** A pass is running now. */
  working: boolean;
  onChanged: () => void;
}) {
  const [focus, setFocus] = useState("");
  const [stopTime, setStopTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = state?.run ?? null;

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setFocus("");
      setStopTime("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-500">
        Loading…
      </div>
    );
  }

  // With no next pass scheduled yet, the first one is starting; a paused run sleeps.
  const agentState: AgentState =
    !run?.pausedAt && (working || !state.nextPassAt) ? "working" : "sleeping";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      {run ? (
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <AgentMark state={agentState} />
            <div className="min-w-0">
              {run.pausedAt !== null ? (
                <div className="flex items-center gap-2 text-sm font-medium text-sky-300">
                  <span className="inline-block h-2 w-2 rounded-full bg-sky-400" />
                  Paused since {new Date(run.pausedAt).toLocaleString()}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                  Heads down since {new Date(run.startedAt).toLocaleString()}
                </div>
              )}
              {run.focus && <p className="mt-1 text-sm text-zinc-300">{run.focus}</p>}
              <p
                className={`mt-1 text-xs ${agentState === "working" ? "text-cyan-300" : "text-zinc-500"}`}
              >
                {describeNextPass(state, run, working)}
              </p>
              <StopTime
                stopAt={run.stopAt}
                disabled={busy}
                onSet={(stopAt) => void runAction(() => setHeadsDownStopAt(stopAt))}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            {run.pausedAt !== null && (
              <ClearButton disabled={busy} onClear={() => void runAction(clearHeadsDown)} />
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction(run.pausedAt !== null ? resumeHeadsDown : pauseHeadsDown)
              }
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {run.pausedAt !== null ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction(stopHeadsDown)}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Stop
            </button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runAction(() =>
              startHeadsDown(focus.trim(), stopTime ? nextOccurrence(stopTime) : undefined),
            );
          }}
        >
          <div className="flex items-start gap-3">
            <AgentMark state="off" />
            <p className="text-sm text-zinc-300">
              Heads-down mode keeps your work streams moving while you focus elsewhere. It starts
              work on tickets, chases CI and reviews, and asks you only what it has to.
            </p>
          </div>
          <div className="flex gap-2">
            <input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="What should it push on? (optional)"
              aria-label="Focus"
              className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
            />
            <input
              type="time"
              value={stopTime}
              onChange={(e) => setStopTime(e.target.value)}
              aria-label="Stop at (optional)"
              title="Stop at (optional)"
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-300"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              Go heads down
            </button>
            <ClearButton disabled={busy} onClear={() => void runAction(clearHeadsDown)} />
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
  const state = useCachedResource<HeadsDownState>(CACHE_KEYS.state, getHeadsDownState);
  const questions = useCachedResource<HeadsDownQuestion[]>(CACHE_KEYS.questions, listOpenQuestions);
  const streams = useCachedResource<WorkStream[]>(CACHE_KEYS.streams, listWorkStreams);
  const passes = useCachedResource<HeadsDownPass[]>(CACHE_KEYS.passes, listPasses);
  const messages = useCachedResource<HeadsDownMessage[]>(
    CACHE_KEYS.messages,
    listHeadsDownMessages,
  );
  const config = useCachedResource<HeadsDownConfig>(CACHE_KEYS.config, getHeadsDownConfig);
  const allowedTools = useCachedResource<AllowedTool[]>(CACHE_KEYS.allowedTools, listAllowedTools);
  const autoApprovals = useCachedResource<HeadsDownQuestion[]>(
    CACHE_KEYS.autoApprovals,
    listAutoApprovals,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshState = state.refresh;
  const refreshQuestions = questions.refresh;
  const refreshStreams = streams.refresh;
  const refreshPasses = passes.refresh;
  const refreshMessages = messages.refresh;
  const refreshAutoApprovals = autoApprovals.refresh;
  const refreshConfig = config.refresh;
  const refreshAll = useCallback(() => {
    void refreshState();
    void refreshQuestions();
    void refreshStreams();
    void refreshPasses();
    void refreshMessages();
    void refreshAutoApprovals();
  }, [
    refreshState,
    refreshQuestions,
    refreshStreams,
    refreshPasses,
    refreshMessages,
    refreshAutoApprovals,
  ]);
  const live = useLivePass(refreshAll);
  const combined = combineResources([state, questions, streams, passes, messages]);

  const openQuestions = questions.data ?? NO_QUESTIONS;

  const refreshAllowedTools = allowedTools.refresh;
  const allowTool = useCallback(
    async (toolId: string) => {
      await setToolAllowed(toolId, true);
      await refreshAllowedTools();
    },
    [refreshAllowedTools],
  );

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-6">
        <RunHeader state={state.data} working={live !== null} onChanged={refreshAll} />
        {(combined.error || combined.refreshing) && (
          <div className="flex items-center gap-3">
            {combined.error && <p className="text-xs text-red-400">{combined.error}</p>}
            <RefreshingIndicator active={combined.refreshing} />
          </div>
        )}

        {openQuestions.length > 0 && (
          <Section title={`Needs you (${openQuestions.length})`}>
            {openQuestions.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                onAnswered={refreshAll}
                onAllowTool={allowTool}
              />
            ))}
          </Section>
        )}

        {(autoApprovals.data ?? NO_QUESTIONS).length > 0 && (
          <Section title="Approved on its own">
            <AutoApprovals approvals={autoApprovals.data ?? NO_QUESTIONS} />
          </Section>
        )}

        <Section title="Work streams">
          <StreamList
            streams={streams.data ?? NO_STREAMS}
            loading={streams.loading}
            onChanged={refreshAll}
          />
        </Section>

        <Section title="What it has been doing">
          <PassList passes={passes.data ?? NO_PASSES} live={live} loading={passes.loading} />
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
            <HeadsDownSettings
              config={config.data}
              allowedTools={allowedTools.data ?? NO_TOOLS}
              onSaved={() => {
                void refreshConfig();
                void refreshAllowedTools();
              }}
            />
          )}
        </Section>
      </aside>
    </div>
  );
}
