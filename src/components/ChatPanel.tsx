import { useCallback, useEffect, useRef, useState } from "react";
import ChatComposer from "./ChatComposer";
import {
  createSession,
  getMessages,
  listProviders,
  listSessions,
  streamChat,
  type ChatMessage,
  type ChatSession,
  type ProviderId,
  type ProviderInfo,
} from "../lib/chat";

interface Display {
  role: string;
  content: string;
}

const PROVIDER_KEY = "yarvis.chat.provider";
const MODEL_KEY = "yarvis.chat.model";

export default function ChatPanel() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [model, setModel] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Display[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

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
          provs.find((p) => p.id === savedProvider) ??
          provs.find((p) => p.available) ??
          provs[0];
        if (chosen) {
          setProvider(chosen.id);
          setModel(
            savedModel && chosen.models.includes(savedModel)
              ? savedModel
              : (chosen.models[0] ?? ""),
          );
        }
        setSessions(await listSessions());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
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
  }, [messages, streaming]);

  const selectSession = useCallback(async (id: string) => {
    setSessionId(id);
    const msgs = await getMessages(id);
    setMessages(msgs.map((m: ChatMessage) => ({ role: m.role, content: m.content })));
  }, []);

  const newChat = useCallback(async () => {
    const session = await createSession();
    setSessions((prev) => [session, ...prev]);
    setSessionId(session.id);
    setMessages([]);
  }, []);

  const onModelsForProvider = useCallback(
    (id: ProviderId) => providers.find((p) => p.id === id)?.models ?? [],
    [providers],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !provider || !model || busy) return;

    let activeId = sessionId;
    if (!activeId) {
      const session = await createSession();
      setSessions((prev) => [session, ...prev]);
      activeId = session.id;
      setSessionId(activeId);
    }

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setBusy(true);
    setError(null);
    let acc = "";
    try {
      for await (const evt of streamChat({
        sessionId: activeId,
        message: text,
        provider,
        model,
      })) {
        if (evt.type === "delta" && evt.text) {
          acc += evt.text;
          setStreaming(acc);
        } else if (evt.type === "error") {
          setError(evt.message ?? "stream error");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (acc) setMessages((prev) => [...prev, { role: "assistant", content: acc }]);
      setStreaming("");
      setBusy(false);
    }
  }, [input, provider, model, busy, sessionId]);

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
        {messages.length === 0 && !streaming && (
          <p className="text-sm text-zinc-600">
            Start a conversation. Set a provider key in Settings if the picker
            shows "(no key)".
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className="text-sm">
            <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
              {m.role}
            </div>
            <div className="whitespace-pre-wrap text-zinc-100">{m.content}</div>
          </div>
        ))}
        {streaming && (
          <div className="text-sm">
            <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
              assistant
            </div>
            <div className="whitespace-pre-wrap text-zinc-100">{streaming}</div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={() => void send()}
        busy={busy}
        placeholder="Message..."
        submitLabel="Send"
      />
    </div>
  );
}
