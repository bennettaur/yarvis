import { ensureOk, sidecarFetch, streamSSE } from "./api";

/**
 * Built-in providers use their bare name; user-configured proxies are
 * namespaced as `custom:<provider-id>`. The frontend treats the id as opaque.
 */
export type ProviderId = string;

/** What a model can be asked to do; mirrors the sidecar's `ModelCapability`. */
export type ModelCapability = "chat" | "stt" | "tts" | "vision" | "embed";

export interface ModelInfo {
  id: string;
  capabilities: ModelCapability[];
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /**
   * Narrowed to the capability that was asked for. A provider can serve models
   * that are no use to the caller — a TTS model has no completion to give — so
   * a picker never sees the whole catalogue.
   */
  models: ModelInfo[];
  available: boolean;
  /** Present (and true) when the entry was contributed by a custom provider. */
  custom?: boolean;
}

export interface ChatSession {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Provenance for a message, mirrored from the sidecar's `ChatMessageMetadata`.
 * Null/absent for messages composed in the app; set by the Telegram bot to mark
 * Telegram-originated messages and record the sender.
 */
export interface ChatMessageMetadata {
  source?: "telegram" | "voice";
  telegramUserId?: number;
  telegramUsername?: string;
  telegramFirstName?: string;
}

/**
 * One tool the assistant ran during a turn, mirrored from the sidecar's
 * `ToolActivity`. Persisted on the assistant message that concluded the turn,
 * so a reloaded thread still shows what it did rather than only what it said.
 */
export interface ToolActivity {
  id: string;
  name: string;
  server?: string;
  args?: unknown;
  status: "pending" | "ok" | "error" | "denied";
  result?: string;
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  metadata?: ChatMessageMetadata | null;
  toolCalls?: ToolActivity[] | null;
  createdAt: string;
}

/** A message as rendered in a thread: its persisted role, text and provenance. */
export interface ThreadMessage {
  role: string;
  content: string;
  metadata?: ChatMessageMetadata | null;
  /** What the assistant ran while producing this reply, in order. */
  activity?: ToolActivity[];
  /** The model's reasoning for this turn, when it returned any. Not persisted. */
  reasoning?: string;
}

/**
 * The label shown above a message. Telegram-originated messages are marked as
 * such and identified by the sender's @username, name, or id, so they're
 * distinguishable from messages composed in the app.
 */
export function messageLabel(role: string, metadata?: ChatMessageMetadata | null): string {
  // A spoken turn is worth marking in the transcript: it was transcribed rather
  // than typed, so a word that looks wrong probably was misheard.
  if (metadata?.source === "voice") return `${role} · spoken`;
  if (metadata?.source === "telegram") {
    const who =
      (metadata.telegramUsername && `@${metadata.telegramUsername}`) ||
      metadata.telegramFirstName ||
      (metadata.telegramUserId != null ? String(metadata.telegramUserId) : "");
    return who ? `Telegram · ${who}` : "Telegram";
  }
  return role;
}

export interface ChatEvent {
  type:
    | "delta"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "done"
    | "error"
    | "attention"
    | "tool_approval_request";
  text?: string;
  message?: string;
  /** `error`: the full redacted diagnosis (status, endpoint, provider body). */
  detail?: string;
  /** `done`: why the model stopped, and how many steps the turn took. */
  finishReason?: string;
  steps?: number;
  /** Present on `attention` events: why the agent needs the user. */
  reason?: string;
  /** `tool_approval_request`: the tool call id to approve or deny. */
  id?: string;
  /** `tool_approval_request`: the tool's registry id, for a standing "always allow". */
  toolId?: string;
  /** `tool_approval_request` and `tool_call`: the tool, its server, its arguments. */
  name?: string;
  server?: string;
  args?: unknown;
  /** `tool_result`: how the call ended, a short rendering of it, and how long it took. */
  status?: ToolActivity["status"];
  result?: string;
  durationMs?: number;
}

/** A pending MCP tool call awaiting the user's approve/deny decision. */
export interface PendingApproval {
  /** The tool call awaiting a decision. */
  id: string;
  /** The tool's registry id (`mcp:<serverId>:<tool>`), for "always allow". */
  toolId?: string;
  name: string;
  server: string;
  args: unknown;
}

/**
 * Providers and the models they serve. Defaults to chat-capable models, which
 * is what every caller of this function is picking between.
 */
export async function listProviders(capability: ModelCapability = "chat"): Promise<ProviderInfo[]> {
  const res = await sidecarFetch(`/api/chat/providers?capability=${capability}`);
  await ensureOk(res, "providers");
  return res.json();
}

export async function listSessions(): Promise<ChatSession[]> {
  const res = await sidecarFetch("/api/chat/sessions");
  await ensureOk(res, "sessions");
  return res.json();
}

export async function createSession(title?: string): Promise<ChatSession> {
  const res = await sidecarFetch("/api/chat/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title ?? null }),
  });
  await ensureOk(res, "create session");
  return res.json();
}

export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  const res = await sidecarFetch(`/api/chat/sessions/${sessionId}/messages`);
  await ensureOk(res, "messages");
  return res.json();
}

export interface ChatRequest {
  sessionId: string;
  message: string;
  provider: ProviderId;
  model: string;
  /** Optional snapshot of the screen the user summoned the chat from. */
  context?: string;
  /**
   * Set by the Voice tab to mark a turn the user spoke rather than typed. The
   * sidecar puts the irreversible tools behind a confirmation for those, since
   * a transcript was never proof-read.
   */
  source?: "voice";
  /** Ask the provider to stream the model's reasoning, where it supports it. */
  reasoning?: boolean;
}

/** Responds to a pending MCP tool-call approval mid-stream. */
export async function respondToToolApproval(toolCallId: string, approved: boolean): Promise<void> {
  const res = await sidecarFetch(`/api/chat/approvals/${encodeURIComponent(toolCallId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  if (!res.ok) throw new Error(`approval failed: ${res.status}`);
}

/**
 * Streams one agent turn. Passing a `signal` lets the caller end it early —
 * aborting the fetch disconnects the SSE stream, which the sidecar treats as
 * the client going away and uses to cancel the upstream model call, so a
 * stopped turn stops costing tokens instead of running to completion unseen.
 */
export async function* streamChat(
  req: ChatRequest,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<ChatEvent> {
  for await (const data of streamSSE("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: options.signal,
  })) {
    yield JSON.parse(data) as ChatEvent;
  }
}

/** How much room one chat turn gets, as Settings edits it. */
export interface ChatConfig {
  maxSteps: number;
  /** Null leaves the provider's own output limit in place. */
  maxOutputTokens: number | null;
}

export async function getChatConfig(): Promise<ChatConfig> {
  const res = await sidecarFetch("/api/chat/config");
  await ensureOk(res, "load chat settings");
  return (await res.json()).config;
}

export async function saveChatConfig(input: ChatConfig): Promise<ChatConfig> {
  const res = await sidecarFetch("/api/chat/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(res, "save chat settings");
  return (await res.json()).config;
}
