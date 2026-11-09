import { useCallback, useEffect, useRef, useState } from "react";
import { ArtifactPaneContext, useArtifactPane } from "../../lib/artifactPane";
import type { ProviderId } from "../../lib/chat";
import { MODEL_HINT, PROVIDER_HINT } from "../../lib/chatControlHints";
import { OMNI_CHAT_SESSION_KEY } from "../../lib/omniChat";
import { collectContext, formatContext } from "../../lib/omniChatContext";
import { useChatThread } from "../../lib/useChatThread";
import { REASONING_HINT, useReasoningPreference } from "../../lib/useReasoningPreference";
import { useVoice } from "../../lib/useVoice";
import ArtifactPane from "../artifacts/ArtifactPane";
import ChatComposer from "../ChatComposer";
import ChatMessages from "../ChatMessages";
import ErrorNotice from "../ErrorNotice";
import McpConnectionBar from "../McpConnectionBar";
import QueuedMessages from "../QueuedMessages";
import SplitPane, { usePersistedRatio } from "../SplitPane";
import ToolApprovalBar from "../ToolApprovalBar";
import VoiceControls from "../voice/VoiceControls";

/**
 * A centered, summon-from-anywhere chat overlay. It stays mounted while hidden
 * so an in-flight request keeps streaming in the background; Esc hides it and
 * re-summoning resumes the same persistent session. The agent can call
 * `request_attention`, which (when the overlay is hidden) bubbles up via
 * `onAttention` to raise a notification and a nav-rail badge.
 */
export default function OmniChat({
  open,
  onClose,
  onAttention,
}: {
  open: boolean;
  onClose: () => void;
  onAttention: (reason: string) => void;
}) {
  const [reasoning, setReasoning] = useReasoningPreference();
  const {
    providers,
    provider,
    setProvider,
    model,
    setModel,
    modelsFor,
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
  } = useChatThread({
    reasoning,
    sessionStorageKey: OMNI_CHAT_SESSION_KEY,
    // collectContext/formatContext are module-level and stable, so this is too.
    getContext: useCallback(() => formatContext(collectContext()), []),
    onAttention,
  });

  const [input, setInput] = useState("");
  // The overlay stays mounted while hidden, so `open` is what says it's on screen.
  const voice = useVoice({ send, streaming, busy, visible: open });
  const panelRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const artifactPane = useArtifactPane();
  const [splitRatio, setSplitRatio] = usePersistedRatio("yarvis.omniChat.artifactSplit", 0.5);

  // Focus the composer whenever the overlay opens.
  useEffect(() => {
    if (open) panelRef.current?.querySelector("textarea")?.focus();
  }, [open]);

  // Keep the thread pinned to the newest message. Skip while hidden so a
  // background stream doesn't run a layout read+write per token off-screen. The
  // body doesn't read messages/streaming, but the effect must re-run as the
  // thread grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on thread growth
  useEffect(() => {
    if (!open) return;
    threadRef.current?.scrollTo(0, threadRef.current.scrollHeight);
  }, [open, messages, streaming, activity]);

  // Esc hides the overlay; the conversation keeps running in the background.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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

  const thread = (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-300">Omni Chat</span>
        <button
          type="button"
          onClick={() => void newChat()}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          New chat
        </button>
        <div className="ml-auto flex items-center gap-2">
          <label title={REASONING_HINT} className="flex items-center gap-1 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={reasoning}
              onChange={(e) => setReasoning(e.target.checked)}
            />
            Thinking
          </label>
          <select
            title={PROVIDER_HINT}
            value={provider}
            onChange={(e) => {
              const id = e.target.value as ProviderId;
              setProvider(id);
              setModel(modelsFor(id)[0] ?? "");
            }}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-xs"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}
                {p.available ? "" : " (no key)"}
              </option>
            ))}
          </select>
          <select
            title={MODEL_HINT}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="max-w-[160px] rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-xs"
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
        className="min-h-[280px] flex-1 space-y-3 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"
      >
        <ChatMessages
          messages={messages}
          streaming={streaming}
          busy={busy}
          thinking={thinking}
          activity={activity}
          onRewind={rewind}
          emptyHint="Ask about whatever you're looking at — it's sent along as context."
        />
      </div>

      <ToolApprovalBar
        approvals={approvals}
        visible={open}
        onRespond={(id, approved) => void respondApproval(id, approved)}
        onAlwaysAllow={(a) => void alwaysAllow(a)}
      />

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

      <McpConnectionBar visible={open} />

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
        placeholder="Ask anything about what you're looking at…"
        submitLabel="Send"
        textareaClassName="min-h-24"
        onStop={stop}
        onQueue={queue}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <VoiceControls voice={voice} compact />
        <p className="text-xs text-zinc-600">Esc to hide · keeps running in the background</p>
      </div>
    </div>
  );

  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center pt-[15vh] ${
        open ? "" : "hidden"
      }`}
    >
      {/* Full-screen backdrop behind the panel; clicking it (anywhere outside
          the panel) hides the overlay. A button keeps it keyboard-accessible. */}
      <button
        type="button"
        aria-label="Close Omni Chat"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/40"
      />
      {/* Wider and a fixed height while an artifact is open, so the pane has room beside the thread. */}
      <div
        ref={panelRef}
        className={`relative z-10 flex flex-col rounded-xl border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-2xl ${
          artifactPane.openId
            ? "h-[80vh] w-[1400px] max-w-[95vw]"
            : "max-h-[80vh] w-[820px] max-w-[92vw]"
        }`}
      >
        <ArtifactPaneContext.Provider value={artifactPane.open}>
          <SplitPane
            orientation="horizontal"
            ratio={splitRatio}
            onRatioChange={setSplitRatio}
            minRatio={0.3}
            className="min-h-0 flex-1"
            first={thread}
            second={
              artifactPane.openId && (
                <div className="h-full py-4 pr-4 pl-3">
                  <ArtifactPane id={artifactPane.openId} onClose={artifactPane.close} />
                </div>
              )
            }
          />
        </ArtifactPaneContext.Provider>
      </div>
    </div>
  );
}
