import { sidecarFetch } from "./api";

export interface CalendarStatus {
  configured: boolean;
  connected: boolean;
  scope: string | null;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  meetLink: string | null;
  htmlLink: string | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await sidecarFetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export const calStatus = () => get<CalendarStatus>("/api/calendar/status");
export const calAuthUrl = () => get<{ url: string }>("/api/calendar/auth-url");
export const calEvents = () => get<CalendarEvent[]>("/api/calendar/events");

/**
 * Fetches events whose start falls within [timeMinIso, timeMaxIso). Backs the
 * week/month/day grids, which need events from the start of the range (often
 * earlier than now), not just upcoming ones.
 */
export const calEventsRange = (
  timeMinIso: string,
  timeMaxIso: string,
  max = 250,
) => {
  const params = new URLSearchParams({
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    max: String(max),
  });
  return get<CalendarEvent[]>(`/api/calendar/events?${params.toString()}`);
};

export const calDisconnect = () =>
  sidecarFetch("/api/calendar/disconnect", { method: "POST" }).then((r) => r.json());
