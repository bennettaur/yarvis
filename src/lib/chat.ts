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

/** Responds to a pending MCP tool-call approval mid-stream. */
export async function respondToToolApproval(toolCallId: string, approved: boolean): Promise<void> {
  const res = await sidecarFetch(`/api/chat/approvals/${encodeURIComponent(toolCallId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  if (!res.ok) throw new Error(`approval failed: ${res.status}`);
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
