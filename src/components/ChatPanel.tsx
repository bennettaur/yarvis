import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArtifactPaneContext, useArtifactPane } from "../lib/artifactPane";
import { type ChatSession, listSessions, type ProviderId } from "../lib/chat";
import { MODEL_HINT, PROVIDER_HINT, SESSION_HINT } from "../lib/chatControlHints";
import { type DisplayError, formatError } from "../lib/errors";
import { useOmniChatOverlayOpen } from "../lib/omniChatOverlay";
import { useChatThread } from "../lib/useChatThread";
import { REASONING_HINT, useReasoningPreference } from "../lib/useReasoningPreference";
import { useVoice } from "../lib/useVoice";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import { PromptInputSelect } from "./ai-elements/prompt-input";
import ArtifactPane from "./artifacts/ArtifactPane";
import ChatComposer from "./ChatComposer";
import ChatMessages from "./ChatMessages";
import ErrorNotice from "./ErrorNotice";
import McpConnectionBar from "./McpConnectionBar";
import QueuedMessages from "./QueuedMessages";
import SplitPane, { usePersistedRatio } from "./SplitPane";
import ToolApprovalBar from "./ToolApprovalBar";
import { Button } from "./ui/button";
import VoiceControls from "./voice/VoiceControls";

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
 * or they overwrite each other's. `focusOnShow` moves focus to the composer
 * each time the panel comes on screen; it is for the Chat tab, not for a panel
 * that appears beside other inputs, such as an Omni widget.
 * `requestedSessionId` opens that chat, re-reading it even when it is already
 * open, since a scheduled task may have added to it in the background; the
 * panel calls `onRequestConsumed` once it has. `requestedArtifactId` opens that
 * artifact beside the conversation, for a link clicked outside any chat; links
 * in this panel's own thread open there directly.
 */
export default function ChatPanel({
  active = true,
  sessionStorageKey,
  focusOnShow = false,
  requestedSessionId = null,
  onRequestConsumed,
  requestedArtifactId = null,
  onArtifactRequestConsumed,
}: {
  active?: boolean;
  sessionStorageKey?: string;
  focusOnShow?: boolean;
  requestedSessionId?: string | null;
  onRequestConsumed?: () => void;
  requestedArtifactId?: string | null;
  onArtifactRequestConsumed?: () => void;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsError, setSessionsError] = useState<DisplayError | null>(null);
  const [input, setInput] = useState("");
  const [reasoning, setReasoning] = useReasoningPreference();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const artifactPane = useArtifactPane();
  const [splitRatio, setSplitRatio] = usePersistedRatio("yarvis.chat.artifactSplit", 0.55);

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
    queued,
    queueHeld,
    enqueue,
    removeQueued,
    sendNextQueued,
    retry,
    rewind,
    stop,
    newChat,
    loadSession,
  } = useChatThread({ onSessionCreated: addSession, reasoning, sessionStorageKey });

  const voice = useVoice({ send, streaming, busy });

  useEffect(() => {
    if (!requestedSessionId) return;
    // Re-reading the open chat mid-reply would cancel the reply; it is already
    // on screen, so leave it be.
    if (requestedSessionId !== sessionId || !busy) void loadSession(requestedSessionId);
    onRequestConsumed?.();
  }, [requestedSessionId, sessionId, busy, loadSession, onRequestConsumed]);

  const { open: openArtifact } = artifactPane;
  useEffect(() => {
    if (!requestedArtifactId) return;
    openArtifact(requestedArtifactId);
    onArtifactRequestConsumed?.();
  }, [requestedArtifactId, openArtifact, onArtifactRequestConsumed]);

  // The Omni Chat overlay covers this panel and carries an approval bar of its
  // own, so ours must stop answering the keyboard while it is up.
  const overlayOpen = useOmniChatOverlayOpen();

  // A hands-free mic left open behind another tab would send what it hears into
  // a chat nobody is looking at.
  const { cancel: cancelVoice } = voice;
  useEffect(() => {
    if (!active) cancelVoice();
  }, [active, cancelVoice]);

  // Focus via a ref rather than `autoFocus`, which Biome flags. Held back while
  // the overlay is up, since it has a composer of its own.
  useEffect(() => {
    if (focusOnShow && active && !overlayOpen) composerRef.current?.focus();
  }, [focusOnShow, active, overlayOpen]);

  // Refetched on each return to the panel: sessions other surfaces created, and
  // titles the sidecar assigned, arrive while it sits hidden. Merged rather than
  // replaced, so a session this panel created while the fetch was in flight
  // stays in the picker.
  useEffect(() => {
    if (!active) return;
    void (async () => {
      try {
        const listed = await listSessions();
        setSessions((prev) => {
          const ids = new Set(listed.map((s) => s.id));
          return [...prev.filter((s) => !ids.has(s.id)), ...listed];
        });
      } catch (e) {
        setSessionsError(formatError(e));
      }
    })();
  }, [active]);

  const queue = () => {
    if (enqueue(input)) setInput("");
  };
  // Cleared straight away, since the box stays usable while the reply runs and
  // `send` only settles when it ends. The text comes back if `send` declines
  // (the provider list may still be loading): a message that vanished without
  // being sent is worse than a button that briefly does nothing.
  // While anything is queued, a new message joins the back of the queue rather
  // than jumping ahead of it.
  const submit = () => {
    if (queued.length > 0) return queue();
    const text = input;
    setInput("");
    void send(text).then((sent) => {
      if (!sent) setInput((current) => current || text);
    });
  };

  const chat = (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void newChat().then(() => composerRef.current?.focus())}
        >
          <PlusIcon />
          New chat
        </Button>
        <select
          title={SESSION_HINT}
          value={sessionId ?? ""}
          onChange={(e) => e.target.value && void loadSession(e.target.value)}
          className="h-8 min-w-0 max-w-80 truncate rounded-md border border-input bg-input/30 px-2 text-sm text-foreground outline-none hover:bg-input/50 focus-visible:border-ring"
        >
          <option value="">— session —</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title ?? s.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>

      <Conversation className="rounded-xl border border-border bg-zinc-900/50">
        <ConversationContent>
          <ChatMessages
            messages={messages}
            streaming={streaming}
            busy={busy}
            emptyHint={EMPTY_HINT}
            thinking={thinking}
            activity={activity}
            onRewind={rewind}
          />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Off screen, an `A` would answer a call nobody can see. */}
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
            <Button variant="outline" size="xs" onClick={retry} disabled={busy}>
              Retry
            </Button>
          }
        />
      )}

      <McpConnectionBar />

      <QueuedMessages
        queued={queued.map((q) => q.text)}
        held={queueHeld}
        onRemove={removeQueued}
        onSendNext={sendNextQueued}
      />

      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={submit}
        busy={busy}
        placeholder="Message..."
        submitLabel="Send"
        maxHeight={360}
        onStop={stop}
        onQueue={queue}
        inputRef={composerRef}
        tools={
          <>
            <label
              title={REASONING_HINT}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <input
                type="checkbox"
                checked={reasoning}
                onChange={(e) => setReasoning(e.target.checked)}
                className="accent-indigo-500"
              />
              Thinking
            </label>
            <PromptInputSelect
              title={PROVIDER_HINT}
              value={provider}
              onChange={(e) => {
                const id = e.target.value as ProviderId;
                setProvider(id);
                setModel(modelsFor(id)[0] ?? "");
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.label}
                  {p.available ? "" : " (no key)"}
                </option>
              ))}
            </PromptInputSelect>
            <PromptInputSelect
              title={MODEL_HINT}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {(provider ? modelsFor(provider) : []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </PromptInputSelect>
          </>
        }
      />

      <VoiceControls voice={voice} />
    </div>
  );

  return (
    <ArtifactPaneContext.Provider value={artifactPane.open}>
      <SplitPane
        orientation="horizontal"
        ratio={splitRatio}
        onRatioChange={setSplitRatio}
        minRatio={0.25}
        className="h-full"
        first={chat}
        second={
          artifactPane.openId && (
            <div className="h-full py-6 pr-6 pl-4">
              <ArtifactPane id={artifactPane.openId} onClose={artifactPane.close} />
            </div>
          )
        }
      />
    </ArtifactPaneContext.Provider>
  );
}
