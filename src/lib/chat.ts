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

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ChatEvent {
  type: "delta" | "done" | "error";
  text?: string;
  message?: string;
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
