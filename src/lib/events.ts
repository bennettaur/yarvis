import { sidecarFetch } from "./api";

/**
 * Client for the local event log. Only the UI-originated event types live here;
 * backend actions (chat started, tasks created/completed) are recorded by the
 * sidecar itself. Recording is best-effort — a failure must never disrupt the
 * action the user actually took, so callers fire-and-forget via `recordEvent`.
 */
export type UiEventType = "pr.viewed" | "alarm.created";

/** One row of the activity log. */
export interface EventRecord {
  id: string;
  type: string;
  source: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
  processedAt: string | null;
  createdAt: string;
}

export interface EventPage {
  items: EventRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface EventQuery {
  types?: string[];
  /** Substring match against the type, source and serialized payload. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** Reads the paginated log for the events browser. */
export async function listEvents(query: EventQuery = {}): Promise<EventPage> {
  const params = new URLSearchParams();
  for (const type of query.types ?? []) params.append("type", type);
  if (query.q) params.set("q", query.q);
  params.set("limit", String(query.limit ?? 50));
  params.set("offset", String(query.offset ?? 0));
  const res = await sidecarFetch(`/api/events?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /api/events → ${res.status}`);
  return res.json();
}

/** The event types the sidecar accepts, for the browser's filter. */
export async function listEventTypes(): Promise<string[]> {
  const res = await sidecarFetch("/api/events/types");
  if (!res.ok) throw new Error(`GET /api/events/types → ${res.status}`);
  return ((await res.json()) as { types: string[] }).types;
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
