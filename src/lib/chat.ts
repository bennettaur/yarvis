import { sidecarFetch, streamSSE } from "./api";

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
  source?: "telegram";
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

/**
 * The label shown above a message. Telegram-originated messages are marked as
 * such and identified by the sender's @username, name, or id, so they're
 * distinguishable from messages composed in the app.
 */
export function messageLabel(role: string, metadata?: ChatMessageMetadata | null): string {
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
  type: "delta" | "done" | "error" | "attention";
  text?: string;
  message?: string;
  /** Present on `attention` events: why the agent needs the user. */
  reason?: string;
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const res = await sidecarFetch("/api/chat/providers");
  if (!res.ok) throw new Error(`providers failed: ${res.status}`);
  return res.json();
}

export async function listSessions(): Promise<ChatSession[]> {
  const res = await sidecarFetch("/api/chat/sessions");
  if (!res.ok) throw new Error(`sessions failed: ${res.status}`);
  return res.json();
}

export async function createSession(title?: string): Promise<ChatSession> {
  const res = await sidecarFetch("/api/chat/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title ?? null }),
  });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  return res.json();
}

export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  const res = await sidecarFetch(`/api/chat/sessions/${sessionId}/messages`);
  if (!res.ok) throw new Error(`messages failed: ${res.status}`);
  return res.json();
}

export interface ChatRequest {
  sessionId: string;
  message: string;
  provider: ProviderId;
  model: string;
  /** Optional snapshot of the screen the user summoned the chat from. */
  context?: string;
}

export async function* streamChat(req: ChatRequest): AsyncGenerator<ChatEvent> {
  for await (const data of streamSSE("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  })) {
    yield JSON.parse(data) as ChatEvent;
  }
}
