import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatMessage,
  createSession,
  getMessages,
  listProviders,
  type PendingApproval,
  type ProviderId,
  type ProviderInfo,
  respondToToolApproval,
  streamChat,
  type ThreadMessage,
} from "./chat";

// Shared with ChatPanel so Omni Chat defaults to the same provider/model the
// user last picked in the main Chat tab.
const PROVIDER_KEY = "yarvis.chat.provider";
const MODEL_KEY = "yarvis.chat.model";

export interface UseChatThreadOptions {
  /** localStorage key under which this thread's session id is persisted. */
  sessionStorageKey?: string;
  /** Builds the screen-context string attached to each outgoing message. */
  getContext?: () => string | undefined;
  /** Invoked when the agent emits an attention signal during a turn. */
  onAttention?: (reason: string) => void;
}

/**
 * The provider/model/session/streaming machinery behind a chat thread, factored
 * out so Omni Chat (and, later, the Chat tab) can share one implementation.
 * Optionally persists its session id to localStorage so the same conversation
 * resumes across summons.
 */
export function useChatThread(options: UseChatThreadOptions = {}) {
  const { sessionStorageKey, getContext, onAttention } = options;

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [model, setModel] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

  const respondApproval = useCallback(async (id: string, approved: boolean) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
    try {
      await respondToToolApproval(id, approved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadSession = useCallback(async (id: string) => {
    setSessionId(id);
    try {
      const msgs = await getMessages(id);
      setMessages(
        msgs.map((m: ChatMessage) => ({ role: m.role, content: m.content, metadata: m.metadata })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Load providers and restore the last-used provider/model.
  useEffect(() => {
    void (async () => {
      try {
        const provs = await listProviders();
        setProviders(provs);
        const savedProvider = localStorage.getItem(PROVIDER_KEY) as ProviderId | null;
        const savedModel = localStorage.getItem(MODEL_KEY);
        const chosen =
          provs.find((p) => p.id === savedProvider) ?? provs.find((p) => p.available) ?? provs[0];
        if (chosen) {
          setProvider(chosen.id);
          setModel(
            savedModel && chosen.models.includes(savedModel)
              ? savedModel
              : (chosen.models[0] ?? ""),
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // Resume the persisted session once on mount.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const persisted = sessionStorageKey ? localStorage.getItem(sessionStorageKey) : null;
    if (persisted) void loadSession(persisted);
  }, [sessionStorageKey, loadSession]);

  // Keep the persisted session id in sync.
  useEffect(() => {
    if (sessionStorageKey && sessionId) localStorage.setItem(sessionStorageKey, sessionId);
  }, [sessionStorageKey, sessionId]);

  useEffect(() => {
    if (provider) localStorage.setItem(PROVIDER_KEY, provider);
    if (model) localStorage.setItem(MODEL_KEY, model);
  }, [provider, model]);

  const modelsFor = useCallback(
    (id: ProviderId) => providers.find((p) => p.id === id)?.models ?? [],
    [providers],
  );

  const newChat = useCallback(async () => {
    const session = await createSession();
    setSessionId(session.id);
    setMessages([]);
    setError(null);
    return session.id;
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !provider || !model || busy) return;

      let activeId = sessionId;
      if (!activeId) {
        const session = await createSession();
        activeId = session.id;
        setSessionId(activeId);
      }

      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      setBusy(true);
      setError(null);
      const context = getContext?.();
      let acc = "";
      try {
        for await (const evt of streamChat({
          sessionId: activeId,
          message: trimmed,
          provider,
          model,
          context,
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
          } else if (evt.type === "attention" && evt.reason) {
            onAttention?.(evt.reason);
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
        // Any approvals not acted on are moot once the turn ends.
        setApprovals([]);
      }
    },
    [provider, model, busy, sessionId, getContext, onAttention],
  );

  return {
    providers,
    provider,
    setProvider,
    model,
    setModel,
    modelsFor,
    sessionId,
    messages,
    streaming,
    busy,
    error,
    approvals,
    respondApproval,
    send,
    newChat,
    loadSession,
  };
}
