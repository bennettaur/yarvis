import { describe, expect, it } from "bun:test";
import { buildAuthUrl, CALENDAR_SCOPE, GoogleCalendarClient, toCalendarEvent } from "./client.ts";

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("google oauth url", () => {
  it("requests offline access and the readonly calendar scope", () => {
    const url = new URL(buildAuthUrl("cid", "http://127.0.0.1:9/cb", "xyz"));
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9/cb");
    expect(url.searchParams.get("scope")).toBe(CALENDAR_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("xyz");
  });
});

describe("toCalendarEvent", () => {
  it("normalizes a timed event with a meet link", () => {
    const ev = toCalendarEvent({
      id: "e1",
      summary: "Standup",
      start: { dateTime: "2026-05-25T09:00:00Z" },
      end: { dateTime: "2026-05-25T09:15:00Z" },
      hangoutLink: "https://meet.google.com/abc",
      htmlLink: "https://calendar.google.com/e1",
    });
    expect(ev).toMatchObject({
      id: "e1",
      title: "Standup",
      allDay: false,
      meetLink: "https://meet.google.com/abc",
    });
  });

  it("flags all-day events and falls back for missing fields", () => {
    const ev = toCalendarEvent({
      id: "e2",
      start: { date: "2026-05-25" },
      end: { date: "2026-05-26" },
    });
    expect(ev.allDay).toBe(true);
    expect(ev.title).toBe("(no title)");
    expect(ev.meetLink).toBeNull();
  });

  it("reads a video link from conferenceData entry points", () => {
    const ev = toCalendarEvent({
      id: "e3",
      summary: "Sync",
      start: { dateTime: "2026-05-25T10:00:00Z" },
      end: { dateTime: "2026-05-25T10:30:00Z" },
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+1" },
          { entryPointType: "video", uri: "https://meet/x" },
        ],
      },
    });
    expect(ev.meetLink).toBe("https://meet/x");
  });
});

describe("listEvents", () => {
  function capturingFetch(captured: { url?: string }): typeof fetch {
    return (async (url: string) => {
      captured.url = String(url);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("sends an explicit time range and orders by start time", async () => {
    const captured: { url?: string } = {};
    const client = new GoogleCalendarClient("cid", "secret", capturingFetch(captured));
    await client.listEvents("at", {
      timeMin: "2026-05-24T00:00:00.000Z",
      timeMax: "2026-05-31T00:00:00.000Z",
      maxResults: 100,
    });
    const url = new URL(captured.url ?? "");
    expect(url.searchParams.get("timeMin")).toBe("2026-05-24T00:00:00.000Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-05-31T00:00:00.000Z");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("maxResults")).toBe("100");
  });

  it("defaults timeMin to now and omits timeMax when unset", async () => {
    const captured: { url?: string } = {};
    const client = new GoogleCalendarClient("cid", "secret", capturingFetch(captured));
    await client.listEvents("at");
    const url = new URL(captured.url ?? "");
    expect(url.searchParams.get("timeMin")).not.toBeNull();
    expect(url.searchParams.has("timeMax")).toBe(false);
  });
});

describe("token exchange", () => {
  it("computes an absolute expiry from expires_in", async () => {
    const client = new GoogleCalendarClient(
      "cid",
      "secret",
      fakeFetch({
        "oauth2.googleapis.com/token": {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: CALENDAR_SCOPE,
        },
      }),
    );
    const before = Date.now();
    const token = await client.exchangeCode("code", "http://127.0.0.1:9/cb");
    expect(token.accessToken).toBe("at");
    expect(token.refreshToken).toBe("rt");
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });
});
