import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { emitEvent } from "../events/service.ts";
import { buildAuthUrl, GoogleCalendarClient, scopeSatisfied } from "./client.ts";
import {
  clearToken,
  consumeState,
  getStoredToken,
  getValidAccessToken,
  issueState,
  saveToken,
} from "./service.ts";

/** Loopback redirect the Google "Desktop app" client returns to after consent. */
function redirectUri(config: Config): string {
  return `http://127.0.0.1:${config.port}/oauth/google/callback`;
}

function makeClient(config: Config): GoogleCalendarClient | null {
  const { googleClientId, googleClientSecret } = config.secrets;
  if (!googleClientId || !googleClientSecret) return null;
  return new GoogleCalendarClient(googleClientId, googleClientSecret);
}

/**
 * A new event. Attendees are capped and validated as addresses because this is
 * the one route that sends mail on the user's behalf — Google notifies everyone
 * invited.
 */
const createEventSchema = z.object({
  title: z.string().min(1).max(300),
  start: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be a timestamp or date"),
  end: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be a timestamp or date"),
  allDay: z.boolean().optional(),
  description: z.string().max(4000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(z.string().email()).max(25).optional(),
  conferenceLink: z.boolean().optional(),
});

/** True when the value is absent or a parseable timestamp (rejects garbage). */
function isIsoOrAbsent(value: string | undefined): boolean {
  return value === undefined || !Number.isNaN(Date.parse(value));
}

/** Authenticated calendar routes, mounted under /api/calendar. */
export function createCalendarRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/status", async (c) => {
    const configured = Boolean(config.secrets.googleClientId && config.secrets.googleClientSecret);
    const token = await getStoredToken(db());
    return c.json({
      configured,
      connected: token !== null,
      scope: token?.scope ?? null,
      // A grant made before the scope widened can read but not create, and the
      // only fix is re-consent — so the UI needs to know before an attempt fails.
      canCreateEvents: token !== null && scopeSatisfied(token.scope),
    });
  });

  router.get("/auth-url", (c) => {
    const { googleClientId } = config.secrets;
    if (!googleClientId) {
      return c.json({ error: "google oauth not configured" }, 400);
    }
    const url = buildAuthUrl(googleClientId, redirectUri(config), issueState());
    return c.json({ url });
  });

  router.get("/events", async (c) => {
    const client = makeClient(config);
    if (!client) return c.json({ error: "google oauth not configured" }, 400);

    const timeMin = c.req.query("timeMin");
    const timeMax = c.req.query("timeMax");
    if (!isIsoOrAbsent(timeMin) || !isIsoOrAbsent(timeMax)) {
      return c.json({ error: "timeMin/timeMax must be ISO timestamps" }, 400);
    }

    try {
      const accessToken = await getValidAccessToken(db(), client);
      const requested = Number(c.req.query("max") ?? "20");
      // A month grid can hold many events, so allow a larger ceiling than the
      // agenda's default while still bounding the response.
      const maxResults = Number.isFinite(requested)
        ? Math.min(250, Math.max(1, Math.trunc(requested)))
        : 20;
      return c.json(await client.listEvents(accessToken, { timeMin, timeMax, maxResults }));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  /**
   * Creates an event on the primary calendar. There is deliberately no update or
   * delete counterpart: the agent can put something on the calendar, and only
   * the user can move or cancel it.
   */
  router.post("/events", async (c) => {
    const client = makeClient(config);
    if (!client) return c.json({ error: "google oauth not configured" }, 400);
    const parsed = createEventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const token = await getStoredToken(db());
    if (!token) return c.json({ error: "calendar not connected" }, 400);
    if (!scopeSatisfied(token.scope)) {
      return c.json(
        { error: "calendar is connected read-only; reconnect to allow creating events" },
        403,
      );
    }

    try {
      const accessToken = await getValidAccessToken(db(), client);
      const event = await client.createEvent(accessToken, parsed.data);
      await emitEvent(db(), {
        type: "calendar.event_created",
        source: "calendar",
        payload: { eventId: event.id, title: event.title, start: event.start },
      });
      return c.json(event, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  router.post("/disconnect", async (c) => {
    await clearToken(db());
    return c.json({ ok: true });
  });

  return router;
}

/**
 * Unauthenticated OAuth callback, mounted at the app root (the loopback
 * redirect can't carry our bearer token). Validates the state nonce, exchanges
 * the code for tokens, and stores them.
 */
export function createGoogleCallbackRoutes(config: Config): Hono {
  const router = new Hono();

  router.get("/oauth/google/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const err = c.req.query("error");
    if (err) return c.html(donePage(`Authorization failed: ${err}`), 400);
    if (!code || !state || !consumeState(state)) {
      return c.html(donePage("Invalid or expired authorization."), 400);
    }
    const client = makeClient(config);
    if (!client || !config.databaseUrl) {
      return c.html(donePage("Calendar integration is not configured."), 400);
    }
    try {
      const token = await client.exchangeCode(code, redirectUri(config));
      await saveToken(getDb(config.databaseUrl).db, token);
      return c.html(donePage("Calendar connected. You can close this tab."));
    } catch (e) {
      return c.html(donePage(`Token exchange failed: ${String(e)}`), 502);
    }
  });

  return router;
}

/** Escapes text for safe interpolation into the callback HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function donePage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Yarvis</title></head><body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>${escapeHtml(message)}</p></body></html>`;
}
