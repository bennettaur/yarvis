/**
 * Minimal Google OAuth + Calendar client over fetch (no SDK). Built for the
 * desktop "installed app" flow: the app opens a consent URL in the system
 * browser and Google redirects to a loopback callback the sidecar serves.
 *
 * Scaffolded against the documented API shapes; exercise end-to-end once a
 * Google Cloud OAuth app (client id/secret) is wired in.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** Read-only calendar access is all the integration needs. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO start; date-only for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  /** Google Meet / video link when present. */
  meetLink: string | null;
  htmlLink: string | null;
}

type FetchFn = typeof fetch;

/**
 * Builds the Google consent URL. `access_type=offline` + `prompt=consent`
 * ensure a refresh token comes back so the integration keeps working unattended.
 */
export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function toTokenResponse(data: any): TokenResponse {
  const expiresInSec = Number(data.expires_in ?? 3600);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}

/** Picks the best video link Google attaches to an event, if any. */
function meetLink(item: any): string | null {
  if (item.hangoutLink) return item.hangoutLink;
  const entry = item.conferenceData?.entryPoints?.find(
    (e: any) => e.entryPointType === "video",
  );
  return entry?.uri ?? null;
}

/** Normalizes a Calendar API event resource into our flat shape. */
export function toCalendarEvent(item: any): CalendarEvent {
  const allDay = Boolean(item.start?.date && !item.start?.dateTime);
  return {
    id: item.id,
    title: item.summary ?? "(no title)",
    start: item.start?.dateTime ?? item.start?.date ?? "",
    end: item.end?.dateTime ?? item.end?.date ?? "",
    allDay,
    location: item.location ?? null,
    meetLink: meetLink(item),
    htmlLink: item.htmlLink ?? null,
  };
}

export class GoogleCalendarClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  /** Exchanges an authorization code for access + refresh tokens. */
  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<TokenResponse> {
    const res = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!res.ok) throw new Error(`google token exchange -> ${res.status}`);
    return toTokenResponse(await res.json());
  }

  /** Trades a refresh token for a fresh access token (no new refresh token). */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    const res = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) throw new Error(`google token refresh -> ${res.status}`);
    return toTokenResponse(await res.json());
  }

  /**
   * Lists events on the primary calendar, soonest first. `timeMin` defaults to
   * now (upcoming events); pass an explicit `timeMin`/`timeMax` to query a date
   * range, e.g. the bounds of a week or month for the grid views.
   */
  async listEvents(
    accessToken: string,
    options: {
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
    } = {},
  ): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: options.timeMin ?? new Date().toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(options.maxResults ?? 20),
    });
    if (options.timeMax) params.set("timeMax", options.timeMax);
    const res = await this.fetchImpl(`${CALENDAR_EVENTS}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`google calendar events -> ${res.status}`);
    const data = (await res.json()) as { items?: any[] };
    return (data.items ?? []).map(toCalendarEvent);
  }

  /** Lists upcoming events on the primary calendar, soonest first. */
  listUpcomingEvents(
    accessToken: string,
    maxResults = 20,
  ): Promise<CalendarEvent[]> {
    return this.listEvents(accessToken, { maxResults });
  }
}
