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

/**
 * Read plus event-create. `calendar.events` is the narrowest scope Google offers
 * that allows creating an event — there is no create-only scope — so the
 * restraint is enforced here instead: this client exposes no update or delete
 * call, and the agent has no tool for one. Changing or cancelling a meeting stays
 * something the user does in their own calendar.
 *
 * Widening the scope means existing tokens no longer cover it, so
 * `scopeSatisfied` drives a re-consent prompt rather than failing a create with
 * an opaque 403.
 */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/**
 * Whether a stored grant covers what we now ask for. A token minted against the
 * old read-only scope satisfies reading but not creating.
 */
export function scopeSatisfied(grantedScope: string | null | undefined): boolean {
  return (grantedScope ?? "").split(/\s+/).includes(CALENDAR_SCOPE);
}

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
export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
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
  const entry = item.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video");
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
  async exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
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

  /**
   * Creates an event on the primary calendar. Deliberately the only write:
   * there is no update or delete here, so a mistaken create can be fixed by the
   * user but nothing already on their calendar can be moved or removed by an
   * agent.
   *
   * `conferenceLink` asks Google to mint a Meet link, which needs the
   * conferenceDataVersion parameter to be honoured at all.
   */
  async createEvent(
    accessToken: string,
    input: {
      title: string;
      /** ISO instant, or a date for an all-day event. */
      start: string;
      end: string;
      allDay?: boolean;
      description?: string;
      location?: string;
      attendees?: string[];
      conferenceLink?: boolean;
    },
  ): Promise<CalendarEvent> {
    const when = (value: string) =>
      input.allDay ? { date: value.slice(0, 10) } : { dateTime: value };
    const body: Record<string, unknown> = {
      summary: input.title,
      start: when(input.start),
      end: when(input.end),
      ...(input.description ? { description: input.description } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.attendees?.length
        ? { attendees: input.attendees.map((email) => ({ email })) }
        : {}),
      ...(input.conferenceLink
        ? {
            conferenceData: {
              createRequest: { requestId: crypto.randomUUID() },
            },
          }
        : {}),
    };
    const params = new URLSearchParams();
    if (input.conferenceLink) params.set("conferenceDataVersion", "1");
    const query = params.toString();
    const res = await this.fetchImpl(`${CALENDAR_EVENTS}${query ? `?${query}` : ""}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`google calendar create -> ${res.status}`);
    return toCalendarEvent(await res.json());
  }
}
