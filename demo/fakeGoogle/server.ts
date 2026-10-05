/**
 * A stand-in for the Google Calendar API and OAuth token endpoint. The sidecar
 * finds it through YARVIS_GOOGLE_CALENDAR_API_URL and YARVIS_GOOGLE_TOKEN_URL.
 *
 * Events are laid out around today, in the runner's time zone, so every
 * recording shows a believable week. Events the app creates are kept, so
 * one made from chat shows up in the calendar afterwards.
 */

import type { Server } from "node:http";
import { type FakeRequest, type FakeResponse, startFakeServer } from "../fakeHttp";

interface GoogleEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
  hangoutLink?: string;
  htmlLink: string;
}

const MEET = "https://meet.google.com/xqa-demo-rec";

/** `daysFromToday` days out, at `hour`:`minute` local time, as an ISO timestamp. */
function localTimeIso(daysFromToday: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** A local calendar date as YYYY-MM-DD, for all-day events. */
function localDate(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Days from today to the next `weekday` (0 = Sunday), counting today. */
function daysUntil(weekday: number): number {
  return (weekday - new Date().getDay() + 7) % 7;
}

function timedEvent(
  id: string,
  summary: string,
  start: string,
  minutes: number,
  extra: Partial<GoogleEvent> = {},
): GoogleEvent {
  const end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
  return {
    id,
    summary,
    start: { dateTime: start },
    end: { dateTime: end },
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    ...extra,
  };
}

function seedEvents(): GoogleEvent[] {
  const thursday = daysUntil(4);
  return [
    timedEvent("standup-0", "Checkout standup", localTimeIso(0, 9, 30), 15, { hangoutLink: MEET }),
    timedEvent("design-0", "Design review: payment step", localTimeIso(0, 14), 45, {
      hangoutLink: MEET,
      location: "Room 4B",
    }),
    timedEvent("focus-0", "Focus: rollout plan", localTimeIso(0, 15, 30), 90),
    timedEvent("standup-1", "Checkout standup", localTimeIso(1, 9, 30), 15, { hangoutLink: MEET }),
    timedEvent("one-on-one-1", "1:1 with Priya", localTimeIso(1, 11), 30, { hangoutLink: MEET }),
    // Always ahead of today, like the seeded "Prep demo for Thursday's review" task.
    timedEvent("review-thu", "Thursday review: checkout v2", localTimeIso(thursday || 7, 15), 60, {
      hangoutLink: MEET,
    }),
    timedEvent("standup-2", "Checkout standup", localTimeIso(2, 9, 30), 15, { hangoutLink: MEET }),
    timedEvent("retro-4", "Checkout retro", localTimeIso(4, 16), 45, { hangoutLink: MEET }),
    {
      id: "offsite",
      summary: "Team offsite",
      start: { date: localDate(8) },
      end: { date: localDate(10) },
      htmlLink: "https://calendar.google.com/event?eid=offsite",
    },
  ];
}

const startOf = (e: GoogleEvent) => new Date(e.start.dateTime ?? `${e.start.date}T00:00:00`);
const endOf = (e: GoogleEvent) => new Date(e.end.dateTime ?? `${e.end.date}T00:00:00`);

/**
 * The request handler. A factory, rather than one shared handler, because
 * each server keeps the events created through it.
 */
export function createGoogleHandler() {
  const events = seedEvents();
  let created = 0;

  /** `events.list`: what overlaps [timeMin, timeMax), soonest first, capped at maxResults. */
  function list(url: URL): FakeResponse {
    const timeMin = new Date(url.searchParams.get("timeMin") ?? 0);
    const timeMaxParam = url.searchParams.get("timeMax");
    const timeMax = timeMaxParam ? new Date(timeMaxParam) : null;
    const maxResults = Number(url.searchParams.get("maxResults") ?? 250);
    const items = events
      .filter((e) => endOf(e) > timeMin && (!timeMax || startOf(e) < timeMax))
      .sort((a, b) => startOf(a).getTime() - startOf(b).getTime())
      .slice(0, maxResults);
    return { json: { items } };
  }

  function insert(url: URL, body: unknown): FakeResponse {
    created += 1;
    const input = body as Omit<GoogleEvent, "id" | "htmlLink"> & { conferenceData?: unknown };
    const event: GoogleEvent = {
      id: `created-${created}`,
      summary: input.summary,
      start: input.start,
      end: input.end,
      location: input.location,
      htmlLink: `https://calendar.google.com/event?eid=created-${created}`,
      ...(url.searchParams.has("conferenceDataVersion") ? { hangoutLink: MEET } : {}),
    };
    events.push(event);
    return { json: event };
  }

  return function handle({ method, url, body }: FakeRequest): FakeResponse {
    if (url.pathname.endsWith("/token")) {
      return {
        json: {
          access_token: "demo-google-access-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.events",
        },
      };
    }
    if (url.pathname.endsWith("/calendars/primary/events")) {
      return method === "POST" ? insert(url, body) : list(url);
    }
    return { status: 404, json: { error: { message: "Not Found" } } };
  };
}

export function startFakeGoogle(port: number): Promise<Server> {
  return startFakeServer("fake-google", port, createGoogleHandler());
}
