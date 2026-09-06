import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatMessage,
  type ChatSession,
  createSession,
  getMessages,
  listProviders,
  listSessions,
  type PendingApproval,
  type ProviderId,
  type ProviderInfo,
  respondToToolApproval,
  streamChat,
  type ThreadMessage,
} from "../lib/chat";
import { type DisplayError, formatError } from "../lib/errors";
import { useVoice } from "../lib/useVoice";
import ChatComposer from "./ChatComposer";
import ChatMessages from "./ChatMessages";
import ErrorNotice from "./ErrorNotice";
import { ToolApprovalPrompt } from "./ToolApprovalPrompt";
import VoiceControls from "./voice/VoiceControls";

const PROVIDER_KEY = "yarvis.chat.provider";
const MODEL_KEY = "yarvis.chat.model";
const EMPTY_HINT =
  'Start a conversation. Set a provider key in Settings if the picker shows "(no key)".';

export default function ChatPanel() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [model, setModel] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);

  const respondApproval = useCallback(async (id: string, approved: boolean) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
    try {
      await respondToToolApproval(id, approved);
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const provs = await listProviders();
        setProviders(provs);
        // Restore the last-used provider/model, falling back to the first
        // available provider and its first model.
        const savedProvider = localStorage.getItem(PROVIDER_KEY) as ProviderId | null;
        const savedModel = localStorage.getItem(MODEL_KEY);
        const chosen =
          provs.find((p) => p.id === savedProvider) ?? provs.find((p) => p.available) ?? provs[0];
        if (chosen) {
          setProvider(chosen.id);
          setModel(
            savedModel && chosen.models.some((m) => m.id === savedModel)
              ? savedModel
              : (chosen.models[0]?.id ?? ""),
          );
        }
        setSessions(await listSessions());
      } catch (e) {
        setError(formatError(e));
      }
    })();
  }, []);

  // Remember the last-used provider/model across sessions.
  useEffect(() => {
    if (provider) localStorage.setItem(PROVIDER_KEY, provider);
    if (model) localStorage.setItem(MODEL_KEY, model);
  }, [provider, model]);

  useEffect(() => {
    threadRef.current?.scrollTo(0, threadRef.current.scrollHeight);
  }, []);

  const selectSession = useCallback(async (id: string) => {
    setSessionId(id);
    const msgs = await getMessages(id);
    setMessages(
      msgs.map((m: ChatMessage) => ({ role: m.role, content: m.content, metadata: m.metadata })),
    );
  }, []);

  const newChat = useCallback(async () => {
    const session = await createSession();
    setSessions((prev) => [session, ...prev]);
    setSessionId(session.id);
    setMessages([]);
  }, []);

  const onModelsForProvider = useCallback(
    (id: ProviderId) => providers.find((p) => p.id === id)?.models.map((m) => m.id) ?? [],
    [providers],
  );

  const sendText = useCallback(
    async (raw: string, options: { source?: "voice" } = {}) => {
      const text = raw.trim();
      if (!text || !provider || !model || busy) return;

      let activeId = sessionId;
      if (!activeId) {
        const session = await createSession();
        setSessions((prev) => [session, ...prev]);
        activeId = session.id;
        setSessionId(activeId);
      }

      setInput("");
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text, metadata: options.source ? { source: "voice" } : null },
      ]);
      setBusy(true);
      setError(null);
      let acc = "";
      try {
        for await (const evt of streamChat({
          sessionId: activeId,
          message: text,
          provider,
          model,
          // Marks a turn the user spoke rather than typed, which is what puts
          // the agent's irreversible tools behind a confirmation.
          source: options.source,
        })) {
          if (evt.type === "delta" && evt.text) {
            acc += evt.text;
            setStreaming(acc);
          } else if (evt.type === "tool_approval_request" && evt.id) {
            const id = evt.id;
            setApprovals((prev) => [
              ...prev,
              { id, name: evt.name ?? id, server: evt.server ?? "", args: evt.args },
            ]);
          } else if (evt.type === "error") {
            setError({ message: evt.message ?? "stream error", detail: evt.detail });
          }
        }
      } catch (e) {
        setError(formatError(e));
      } finally {
        if (acc) setMessages((prev) => [...prev, { role: "assistant", content: acc }]);
        setStreaming("");
        setBusy(false);
        // Any approvals not acted on are moot once the turn ends.
        setApprovals([]);
      }
    },
    [provider, model, busy, sessionId],
  );

  const voice = useVoice({ send: sendText, streaming, busy });

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void newChat()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >
          New chat
        </button>
        <select
          value={sessionId ?? ""}
          onChange={(e) => e.target.value && void selectSession(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
        >
          <option value="">— session —</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title ?? s.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <select
            value={provider}
            onChange={(e) => {
              const id = e.target.value as ProviderId;
              setProvider(id);
              setModel(onModelsForProvider(id)[0] ?? "");
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
            {(provider ? onModelsForProvider(provider) : []).map((m) => (
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
        />
        {approvals.map((a) => (
          <ToolApprovalPrompt
            key={a.id}
            approval={a}
            onRespond={(approved) => void respondApproval(a.id, approved)}
          />
        ))}
      </div>

      {error && <ErrorNotice error={error} onDismiss={() => setError(null)} />}

      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={() => void sendText(input)}
        busy={busy}
        placeholder="Message..."
        submitLabel="Send"
        maxHeight={360}
      />

      <VoiceControls voice={voice} />
    </div>
  );
}
