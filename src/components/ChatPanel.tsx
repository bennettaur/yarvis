import { useCallback, useEffect, useRef, useState } from "react";
import { type ChatSession, listSessions, type ProviderId } from "../lib/chat";
import { type DisplayError, formatError } from "../lib/errors";
import { useChatThread } from "../lib/useChatThread";
import { useReasoningPreference } from "../lib/useReasoningPreference";
import { useVoice } from "../lib/useVoice";
import ChatComposer from "./ChatComposer";
import ChatMessages from "./ChatMessages";
import ErrorNotice from "./ErrorNotice";
import ToolApprovalBar from "./ToolApprovalBar";
import VoiceControls from "./voice/VoiceControls";

const EMPTY_HINT =
  'Start a conversation. Set a provider key in Settings if the picker shows "(no key)".';

/**
 * The Chat tab: a thread plus the session picker the overlay doesn't have.
 * Everything about running a turn — providers, streaming, approvals, errors —
 * belongs to `useChatThread`, so both chat surfaces behave identically.
 */
export default function ChatPanel() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsError, setSessionsError] = useState<DisplayError | null>(null);
  const [input, setInput] = useState("");
  const [reasoning, setReasoning] = useReasoningPreference();
  const threadRef = useRef<HTMLDivElement>(null);

  const addSession = useCallback((session: ChatSession) => {
    setSessions((prev) => [session, ...prev]);
  }, []);

  const {
    providers,
    provider,
    setProvider,
    model,
    setModel,
    modelsFor,
    sessionId,
    messages,
    streaming,
    thinking,
    activity,
    busy,
    error,
    approvals,
    respondApproval,
    alwaysAllow,
    send,
    retry,
    stop,
    newChat,
    loadSession,
  } = useChatThread({ onSessionCreated: addSession, reasoning });

  const voice = useVoice({ send, streaming, busy });

  useEffect(() => {
    void (async () => {
      try {
        setSessions(await listSessions());
      } catch (e) {
        setSessionsError(formatError(e));
      }
    })();
  }, []);

  // Keep the thread pinned to the newest message as it grows. The body doesn't
  // read messages/streaming, but the effect must re-run as the thread does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on thread growth
  useEffect(() => {
    threadRef.current?.scrollTo(0, threadRef.current.scrollHeight);
  }, [messages, streaming]);

  // Clear only once the turn is under way: `send` declines while the provider
  // list is still loading, and a message that vanished without being sent is
  // worse than a button that briefly does nothing.
  const submit = () => {
    void send(input).then((sent) => {
      if (sent) setInput("");
    });
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void newChat()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >
          New chat
        </button>
        <select
          value={sessionId ?? ""}
          onChange={(e) => e.target.value && void loadSession(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
        >
          <option value="">— session —</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title ?? s.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={reasoning}
              onChange={(e) => setReasoning(e.target.checked)}
            />
            Thinking
          </label>
          <select
            value={provider}
            onChange={(e) => {
              const id = e.target.value as ProviderId;
              setProvider(id);
              setModel(modelsFor(id)[0] ?? "");
            }}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}
                {p.available ? "" : " (no key)"}
              </option>
            ))}
          </select>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
          >
            {(provider ? modelsFor(provider) : []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        ref={threadRef}
        className="flex-1 space-y-4 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"
      >
        <ChatMessages
          messages={messages}
          streaming={streaming}
          busy={busy}
          emptyHint={EMPTY_HINT}
          thinking={thinking}
          activity={activity}
        />
      </div>

      <ToolApprovalBar
        approvals={approvals}
        onRespond={(id, approved) => void respondApproval(id, approved)}
        onAlwaysAllow={(a) => void alwaysAllow(a)}
      />

      {sessionsError && (
        <ErrorNotice error={sessionsError} onDismiss={() => setSessionsError(null)} />
      )}
      {error && (
        <ErrorNotice
          error={error}
          actions={
            <button
              type="button"
              onClick={retry}
              disabled={busy}
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              Retry
            </button>
          }
        />
      )}

      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={submit}
        busy={busy}
        placeholder="Message..."
        submitLabel="Send"
        maxHeight={360}
        onStop={stop}
      />

      <VoiceControls voice={voice} />
    </div>
  );
}
