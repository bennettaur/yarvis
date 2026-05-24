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

export const calDisconnect = () =>
  sidecarFetch("/api/calendar/disconnect", { method: "POST" }).then((r) => r.json());
