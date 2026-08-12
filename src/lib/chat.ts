import { ensureOk, sidecarFetch, streamSSE } from "./api";

/**
 * Built-in providers use their bare name; user-configured proxies are
 * namespaced as `custom:<provider-id>`. The frontend treats the id as opaque.
 */
export type ProviderId = string;

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  models: string[];
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

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  metadata?: ChatMessageMetadata | null;
  createdAt: string;
}

/** A message as rendered in a thread: its persisted role, text and provenance. */
export interface ThreadMessage {
  role: string;
  content: string;
  metadata?: ChatMessageMetadata | null;
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
  type: "delta" | "done" | "error" | "attention" | "tool_approval_request";
  text?: string;
  message?: string;
  /** Present on `attention` events: why the agent needs the user. */
  reason?: string;
  /** `tool_approval_request`: the tool call id to approve or deny. */
  id?: string;
  /** `tool_approval_request`: the tool name, owning server, and arguments. */
  name?: string;
  server?: string;
  args?: unknown;
}

/** A pending MCP tool call awaiting the user's approve/deny decision. */
export interface PendingApproval {
  id: string;
  name: string;
  server: string;
  args: unknown;
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const res = await sidecarFetch("/api/chat/providers");
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
