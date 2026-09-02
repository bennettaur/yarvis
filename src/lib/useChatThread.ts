import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatMessage,
  type ChatSession,
  createSession,
  getMessages,
  listProviders,
  type PendingApproval,
  type ProviderId,
  type ProviderInfo,
  respondToToolApproval,
  streamChat,
  type ThreadMessage,
  type ToolActivity,
} from "./chat";
import { type DisplayError, formatError } from "./errors";
import { setToolSettings } from "./mcp";

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
  /**
   * Ask the provider for the model's reasoning. Costs tokens and latency where
   * it is supported, so it is the surface's (and the user's) choice.
   */
  reasoning?: boolean;
  /**
   * Invoked with each session this thread creates, including the one an empty
   * thread opens on its first send. A caller that renders a session list needs
   * to hear about those, since the hook owns when they happen.
   */
  onSessionCreated?: (session: ChatSession) => void;
}

/**
 * The provider/model/session/streaming machinery behind a chat thread. Both
 * chat surfaces — the Chat tab and the Omni Chat overlay — run on this one
 * implementation, so a turn behaves the same wherever it was typed. Optionally
 * persists its session id to localStorage so the same conversation resumes
 * across summons.
 */
export function useChatThread(options: UseChatThreadOptions = {}) {
  const { sessionStorageKey, getContext, onAttention, onSessionCreated, reasoning } = options;

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [model, setModel] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [thinking, setThinking] = useState("");
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

  // Lets the surface end a turn early. Aborting the fetch disconnects the SSE
  // stream, which the sidecar reads as the client going away and uses to cancel
  // the upstream call, so a stopped turn stops costing tokens.
  const inFlight = useRef<AbortController | null>(null);
  const stop = useCallback(() => {
    inFlight.current?.abort();
  }, []);

  const respondApproval = useCallback(async (id: string, approved: boolean) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
    try {
      await respondToToolApproval(id, approved);
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  /**
   * Records standing consent for the tool this call belongs to, then approves
   * the call. Only MCP tools carry a registry id here — a built-in's
   * confirmation follows from how the turn was composed, not from a preference.
   */
  const alwaysAllow = useCallback(
    async (approval: PendingApproval) => {
      if (approval.toolId?.startsWith("mcp:")) {
        try {
          await setToolSettings(approval.toolId, { approval: "auto" });
        } catch (e) {
          // The call itself can still go ahead; only the memory of it failed.
          setError(formatError(e));
        }
      }
      await respondApproval(approval.id, true);
    },
    [respondApproval],
  );

  const loadSession = useCallback(async (id: string) => {
    setSessionId(id);
    try {
      const msgs = await getMessages(id);
      setMessages(
        msgs.map((m: ChatMessage) => ({
          role: m.role,
          content: m.content,
          metadata: m.metadata,
          activity: m.toolCalls ?? undefined,
        })),
      );
    } catch (e) {
      setError(formatError(e));
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
            savedModel && chosen.models.some((m) => m.id === savedModel)
              ? savedModel
              : (chosen.models[0]?.id ?? ""),
          );
        }
      } catch (e) {
        setError(formatError(e));
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
    (id: ProviderId) => providers.find((p) => p.id === id)?.models.map((m) => m.id) ?? [],
    [providers],
  );

  const newChat = useCallback(async () => {
    const session = await createSession();
    setSessionId(session.id);
    setMessages([]);
    setError(null);
    onSessionCreated?.(session);
    return session;
  }, [onSessionCreated]);

  const send = useCallback(
    async (text: string, sendOptions: { source?: "voice"; resend?: boolean } = {}) => {
      const trimmed = text.trim();
      if (!trimmed || !provider || !model || busy) return;

      let activeId = sessionId;
      if (!activeId) {
        const session = await createSession();
        activeId = session.id;
        setSessionId(activeId);
        onSessionCreated?.(session);
      }

      // A retry re-sends a message the thread is already showing; the sidecar
      // recognises it as the same turn rather than recording it twice.
      if (!sendOptions.resend) {
        setMessages((prev) => [
          ...prev,
          {
            role: "user",
            content: trimmed,
            metadata: sendOptions.source ? { source: "voice" } : null,
          },
        ]);
      }
      setBusy(true);
      setError(null);
      setThinking("");
      setActivity([]);
      const context = getContext?.();
      const controller = new AbortController();
      inFlight.current = controller;
      let acc = "";
      let thought = "";
      const ran: ToolActivity[] = [];
      try {
        for await (const evt of streamChat(
          {
            sessionId: activeId,
            message: trimmed,
            provider,
            model,
            context,
            reasoning,
            // Marks a turn the user spoke rather than typed, which is what puts
            // the agent's irreversible tools behind a confirmation.
            source: sendOptions.source,
          },
          { signal: controller.signal },
        )) {
          if (evt.type === "delta" && evt.text) {
            acc += evt.text;
            setStreaming(acc);
          } else if (evt.type === "reasoning" && evt.text) {
            thought += evt.text;
            setThinking(thought);
          } else if (evt.type === "tool_call" && evt.id) {
            ran.push({
              id: evt.id,
              name: evt.name ?? evt.id,
              server: evt.server,
              args: evt.args,
              status: "pending",
            });
            setActivity([...ran]);
          } else if (evt.type === "tool_result" && evt.id) {
            const entry = ran.find((a) => a.id === evt.id);
            if (entry) {
              entry.status = evt.status ?? "ok";
              entry.result = evt.result;
              entry.durationMs = evt.durationMs;
              setActivity([...ran]);
            }
          } else if (evt.type === "tool_approval_request" && evt.id) {
            const id = evt.id;
            setApprovals((prev) => [
              ...prev,
              {
                id,
                toolId: evt.toolId,
                name: evt.name ?? id,
                server: evt.server ?? "",
                args: evt.args,
              },
            ]);
          } else if (evt.type === "attention" && evt.reason) {
            onAttention?.(evt.reason);
          } else if (evt.type === "error") {
            setError({ message: evt.message ?? "stream error", detail: evt.detail });
          }
        }
      } catch (e) {
        // Stopping is the user's own doing, not a failure to report. Nothing was
        // persisted for the turn, so the partial reply goes with it rather than
        // sitting in a transcript that a reload would not reproduce.
        if (controller.signal.aborted) {
          acc = "";
          setError({ message: "Turn stopped. Nothing was saved for it." });
        } else {
          setError(formatError(e));
        }
      } finally {
        inFlight.current = null;
        // A failed turn keeps its activity on screen rather than in the
        // transcript: nothing was persisted for it, and the tools it did run are
        // what explains the failure.
        if (acc) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: acc,
              activity: ran.length ? ran : undefined,
              reasoning: thought || undefined,
            },
          ]);
          setThinking("");
          setActivity([]);
        }
        setStreaming("");
        setBusy(false);
        // Any approvals not acted on are moot once the turn ends.
        setApprovals([]);
      }
    },
    [provider, model, busy, sessionId, getContext, onAttention, onSessionCreated, reasoning],
  );

  /**
   * Runs the last user message again. Used after a failure, where the reply is
   * what went missing — asking the user to retype what they already sent is
   * the app admitting it lost their message.
   */
  const retry = useCallback(() => {
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (!last || busy) return;
    void send(last.content, { resend: true });
  }, [messages, busy, send]);

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
  };
}
