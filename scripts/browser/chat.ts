/**
 * Relays the side panel's chat to a sidecar's `/browser/chat` routes.
 *
 * The extension asks for one operation at a time and the host turns it into a
 * fixed request, so the panel can reach these routes and no others. A turn's
 * server-sent events are passed back one native message each, as they arrive.
 */
import type { Instance } from "./instances.ts";

export interface ChatRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  stream: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tool call ids are provider-made (`toolu_…`, `call_…`); nothing that could change the path. */
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Null for anything the panel isn't allowed to ask for. */
export function chatRequest(message: unknown): ChatRequest | null {
  const m = message as Record<string, unknown> | null;
  switch (m?.op) {
    case "sessions":
      return { method: "GET", path: "/browser/chat/sessions", stream: false };
    case "create_session":
      return {
        method: "POST",
        path: "/browser/chat/sessions",
        body: { title: typeof m.title === "string" ? m.title : null },
        stream: false,
      };
    case "messages":
      if (typeof m.sessionId !== "string" || !UUID.test(m.sessionId)) return null;
      return {
        method: "GET",
        path: `/browser/chat/sessions/${m.sessionId}/messages`,
        stream: false,
      };
    case "send":
      if (typeof m.sessionId !== "string" || !UUID.test(m.sessionId)) return null;
      if (typeof m.message !== "string") return null;
      return {
        method: "POST",
        path: "/browser/chat",
        body: { sessionId: m.sessionId, message: m.message, tab: m.tab },
        stream: true,
      };
    case "approve":
      if (typeof m.toolCallId !== "string" || !TOOL_CALL_ID.test(m.toolCallId)) return null;
      if (typeof m.approved !== "boolean") return null;
      return {
        method: "POST",
        path: `/browser/chat/approvals/${m.toolCallId}`,
        body: { approved: m.approved },
        stream: false,
      };
    default:
      return null;
  }
}

/** Splits a text/event-stream into the JSON payloads of its `data:` lines. */
export class SseDecoder {
  private buffered = "";

  push(text: string): unknown[] {
    this.buffered += text.replace(/\r\n/g, "\n");
    const events: unknown[] = [];
    let end = this.buffered.indexOf("\n\n");
    while (end >= 0) {
      const block = this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          events.push(JSON.parse(data));
        } catch {
          // A malformed event is dropped; the turn's own done or error still follows.
        }
      }
      end = this.buffered.indexOf("\n\n");
    }
    return events;
  }
}

export interface ChatReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Runs one operation against `instance`. A streamed turn calls `onEvent` for
 * each event and resolves once the stream ends.
 */
export async function relayChat(
  instance: Instance,
  request: ChatRequest,
  onEvent: (event: unknown) => void,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatReply> {
  const res = await fetchImpl(`http://127.0.0.1:${instance.port}${request.path}`, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${instance.token}`,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const error = typeof body?.error === "string" ? body.error : `Yarvis answered ${res.status}.`;
    return { ok: false, error };
  }
  if (!request.stream) return { ok: true, data: await res.json() };

  // A turn that fails inside the stream closes it without a word, which must
  // not look like a reply that was just empty.
  let ended = false;
  const forward = (event: unknown) => {
    const type = (event as { type?: unknown } | null)?.type;
    if (type === "done" || type === "error") ended = true;
    onEvent(event);
  };

  const reader = res.body?.getReader();
  if (!reader) return { ok: false, error: "Yarvis sent no reply." };
  const decoder = new TextDecoder();
  const events = new SseDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of events.push(decoder.decode(value, { stream: true }))) forward(event);
  }
  return ended ? { ok: true } : { ok: false, error: "The turn ended without an answer." };
}
