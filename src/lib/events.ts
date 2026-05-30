import { sidecarFetch } from "./api";

/**
 * Client for the local event log. Only the UI-originated event types live here;
 * backend actions (chat started, tasks created/completed) are recorded by the
 * sidecar itself. Recording is best-effort — a failure must never disrupt the
 * action the user actually took, so callers fire-and-forget via `recordEvent`.
 */
export type UiEventType = "pr.viewed" | "alarm.created";

export interface EventRecord {
  id: string;
  type: string;
  source: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
  processedAt: string | null;
  createdAt: string;
}

/**
 * Records a UI event, swallowing failures. Intentionally not awaited at call
 * sites: analytics should never block or break a user action.
 */
export async function recordEvent(
  type: UiEventType,
  payload?: Record<string, unknown>,
  source?: string,
): Promise<void> {
  try {
    await sidecarFetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload, source }),
    });
  } catch (e) {
    console.warn(`[events] failed to record ${type}:`, e);
  }
}

export async function listEvents(params?: {
  type?: string;
  limit?: number;
}): Promise<EventRecord[]> {
  const qs = new URLSearchParams();
  if (params?.type) qs.set("type", params.type);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  const res = await sidecarFetch(`/api/events${suffix}`);
  if (!res.ok) throw new Error(`/api/events -> ${res.status}`);
  return res.json();
}
