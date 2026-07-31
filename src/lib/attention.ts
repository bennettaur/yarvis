import { ensureOk, sidecarFetch, streamSSE } from "./api";

/**
 * Client for the sidecar's attention stream (`/api/attention`). The store in
 * `attentionStore.ts` drives this — hydrating the pending list, opening the live
 * SSE stream, and patching an item's status as the user reads / dismisses it.
 */

export type AttentionSource = "claude-hook" | "chat-agent" | "system";
export type AttentionKind = "permission" | "idle" | "completed" | "error" | "info";
export type AttentionStatus = "pending" | "read" | "resolved" | "dismissed";

/** Where clicking an item should take the user; mirrors the sidecar union. */
export type AttentionNavTarget =
  | { type: "workspace-claude"; workspaceId: string }
  | { type: "workspace"; workspaceId: string }
  /** A specific terminal tab/pane, addressed by its PTY session id. */
  | { type: "terminal"; sessionKey: string; workspaceId?: string }
  | { type: "chat" }
  | { type: "pr"; owner: string; repo: string; number: number }
  | { type: "issue"; provider: string; sourceKey: string; externalId: string }
  | { type: "task"; taskId: string };

export interface AttentionItem {
  id: string;
  seq: number;
  source: AttentionSource;
  sessionKey: string | null;
  workspaceId: string | null;
  kind: AttentionKind;
  title: string;
  body: string | null;
  status: AttentionStatus;
  navTarget: AttentionNavTarget | null;
  createdAt: string;
  updatedAt: string;
}

/** A frame on the live stream: a changed item, or a keep-alive ping. */
export type AttentionStreamEvent = { type: "item"; item: AttentionItem } | { type: "ping" };

/** Lists attention items, optionally filtered by status. Newest-first. */
export async function getAttention(status?: AttentionStatus): Promise<AttentionItem[]> {
  const query = status ? `?status=${status}` : "";
  const res = await sidecarFetch(`/api/attention${query}`);
  await ensureOk(res, "list attention");
  return res.json();
}

/** Moves an item through its lifecycle (read / resolved / dismissed). */
export async function patchAttention(
  id: string,
  status: Exclude<AttentionStatus, "pending">,
): Promise<AttentionItem> {
  const res = await sidecarFetch(`/api/attention/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  await ensureOk(res, "update attention");
  return res.json();
}

/** Everything a scoped clear covers: one terminal session, or a whole workspace. */
export interface AttentionScope {
  sessionKey?: string;
  workspaceId?: string;
}

/**
 * Moves every pending item in a scope at once — one request for "I'm looking at
 * this workspace now" instead of one per item. Returns the updated items.
 */
export async function clearAttention(
  scope: AttentionScope,
  status: Exclude<AttentionStatus, "pending">,
): Promise<AttentionItem[]> {
  const res = await sidecarFetch("/api/attention/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...scope, status }),
  });
  await ensureOk(res, "clear attention");
  return res.json();
}

/**
 * Opens the live SSE stream and yields each parsed frame. `signal` aborts the
 * underlying fetch so the store can tear the stream down on unsubscribe. The
 * stream is forward-only; a client recovers missed events by re-hydrating from
 * `getAttention` on reconnect.
 */
export async function* streamAttention(signal: AbortSignal): AsyncGenerator<AttentionStreamEvent> {
  for await (const data of streamSSE("/api/attention/stream", { signal })) {
    try {
      yield JSON.parse(data) as AttentionStreamEvent;
    } catch (e) {
      // Ignore an unparseable frame rather than killing the stream, but log it.
      console.warn("[attention] dropped unparseable stream frame:", e);
    }
  }
}
