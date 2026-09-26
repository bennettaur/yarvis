import { useCallback, useEffect, useRef, useState } from "react";
import { type ChatSession, listSessions, type ProviderId } from "../lib/chat";
import { type DisplayError, formatError } from "../lib/errors";
import { useOmniChatOverlayOpen } from "../lib/omniChatOverlay";
import { useChatThread } from "../lib/useChatThread";
import { useReasoningPreference } from "../lib/useReasoningPreference";
import { useVoice } from "../lib/useVoice";
import ChatComposer from "./ChatComposer";
import ChatMessages from "./ChatMessages";
import ErrorNotice from "./ErrorNotice";
import ToolApprovalBar from "./ToolApprovalBar";
import VoiceControls from "./voice/VoiceControls";

/** localStorage key under which the Chat tab's open session id is kept. */
export const CHAT_TAB_SESSION_KEY = "yarvis.chat.sessionId";

const EMPTY_HINT =
  'Start a conversation. Set a provider key in Settings if the picker shows "(no key)".';

/**
 * The Chat tab: a thread plus the session picker the overlay doesn't have.
 * Everything about running a turn — providers, streaming, approvals, errors —
 * belongs to `useChatThread`, so both chat surfaces behave identically.
 *
 * `active` is false while the host keeps the panel mounted but off screen, so a
 * turn keeps streaming after the user switches away. `sessionStorageKey`
 * reopens the last session on mount; each mounted instance needs its own key,
 * or they overwrite each other's.
 */
export default function ChatPanel({
  active = true,
  sessionStorageKey,
}: {
  active?: boolean;
  sessionStorageKey?: string;
}) {
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
  } = useChatThread({ onSessionCreated: addSession, reasoning, sessionStorageKey });

  const voice = useVoice({ send, streaming, busy });

  // The Omni Chat overlay covers this panel and carries an approval bar of its
  // own, so ours must stop answering the keyboard while it is up — and while the
  // host keeps it off screen, where an `A` would answer a call nobody can see.
  const overlayOpen = useOmniChatOverlayOpen();

  // Refetched on each return to the panel: sessions other surfaces created, and
  // titles the sidecar assigned, arrive while it sits hidden.
  useEffect(() => {
    if (!active) return;
    void (async () => {
      try {
        setSessions(await listSessions());
      } catch (e) {
        setSessionsError(formatError(e));
      }
    })();
  }, [active]);

  // Keep the thread pinned to the newest message as it grows. Skip while hidden
  // so a background stream doesn't run a layout read+write per token off-screen;
  // re-pins on return. The body doesn't read messages/streaming, but the effect
  // must re-run as the thread does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on thread growth
  useEffect(() => {
    if (!active) return;
    threadRef.current?.scrollTo(0, threadRef.current.scrollHeight);
  }, [active, messages, streaming, activity]);

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
        visible={active && !overlayOpen}
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
