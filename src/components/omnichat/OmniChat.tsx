import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderId } from "../../lib/chat";
import { OMNI_CHAT_SESSION_KEY } from "../../lib/omniChat";
import { collectContext, formatContext } from "../../lib/omniChatContext";
import { useChatThread } from "../../lib/useChatThread";
import { useReasoningPreference } from "../../lib/useReasoningPreference";
import { useVoice } from "../../lib/useVoice";
import ChatComposer from "../ChatComposer";
import ChatMessages from "../ChatMessages";
import ErrorNotice from "../ErrorNotice";
import { ToolApprovalPrompt } from "../ToolApprovalPrompt";
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
    send,
    newChat,
  } = useChatThread({
    reasoning,
    sessionStorageKey: OMNI_CHAT_SESSION_KEY,
    // collectContext/formatContext are module-level and stable, so this is too.
    getContext: useCallback(() => formatContext(collectContext()), []),
    onAttention,
  });

  const [input, setInput] = useState("");
  const voice = useVoice({ send, streaming, busy });
  const panelRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

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

  const submit = () => {
    const text = input;
    setInput("");
    void send(text);
  };

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
      <div
        ref={panelRef}
        className="relative z-10 flex max-h-[80vh] w-[820px] max-w-[92vw] flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 shadow-2xl"
      >
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
            emptyHint="Ask about whatever you're looking at — it's sent along as context."
          />
          {approvals.map((a) => (
            <ToolApprovalPrompt
              key={a.id}
              approval={a}
              onRespond={(approved) => void respondApproval(a.id, approved)}
            />
          ))}
        </div>

        {error && <ErrorNotice error={error} />}

        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={submit}
          busy={busy}
          placeholder="Ask anything about what you're looking at…"
          submitLabel="Send"
          textareaClassName="min-h-24"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <VoiceControls voice={voice} compact />
          <p className="text-xs text-zinc-600">Esc to hide · keeps running in the background</p>
        </div>
      </div>
    </div>
  );
}
