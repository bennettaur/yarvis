/**
 * Signs the user in to GitHub with the OAuth device flow.
 *
 * The device flow is the one GitHub OAuth flow that needs no client secret, so
 * it works in a distributed desktop app: the user enters a short code at
 * github.com/login/device, approves the app, and we poll GitHub until it hands
 * back their token. OAuth App tokens don't expire, so there is nothing to
 * refresh. https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

/**
 * The Yarvis OAuth App's client ID. A client ID is public by design, and the
 * device flow never uses a secret. Empty turns sign-in off unless
 * `YARVIS_GITHUB_CLIENT_ID` names an app.
 */
const DEFAULT_CLIENT_ID = "";

/** Issues and PRs in private repos need `repo`; org membership needs `read:org`. */
const SCOPES = "repo read:org";

// Always github.com: the demo's endpoint overrides stand in for the REST and
// GraphQL APIs, and sign-in only runs when a real OAuth App client ID is set.
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_VERIFICATION_URI = "https://github.com/login/device";

export function githubClientId(env: Record<string, string | undefined> = process.env): string {
  return env.YARVIS_GITHUB_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

export type DeviceFlowStatus =
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: string }
  | { state: "authorized"; login: string | null }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "failed"; error: string };

export interface DeviceFlowStart {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}

interface DeviceFlowDeps {
  clientId: string;
  fetchImpl?: typeof fetch;
  /** Stores the token once GitHub issues it. */
  saveToken: (token: string) => Promise<void>;
  /** The account the token belongs to, so Settings can show who signed in. */
  lookupLogin?: (token: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Flow {
  id: string;
  status: DeviceFlowStatus;
  cancelled: boolean;
}

/**
 * Runs at most one sign-in at a time. Starting a new one cancels the last, so
 * a user who closes the dialog and tries again isn't racing an old poll loop.
 */
export class GitHubDeviceFlow {
  private current: Flow | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: DeviceFlowDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<DeviceFlowStart> {
    if (this.current) {
      this.current.cancelled = true;
      this.current = null;
    }

    const body = await this.post(DEVICE_CODE_URL, {
      client_id: this.deps.clientId,
      scope: SCOPES,
    });
    if (typeof body.device_code !== "string" || typeof body.user_code !== "string") {
      throw new Error(describeOAuthError(body, "GitHub didn't return a device code"));
    }

    const expiresAtMs = this.now() + Number(body.expires_in ?? 900) * 1000;
    const pending = {
      state: "pending",
      userCode: body.user_code,
      verificationUri: githubUri(body.verification_uri),
      expiresAt: new Date(expiresAtMs).toISOString(),
    } as const;
    const flow: Flow = { id: crypto.randomUUID(), status: pending, cancelled: false };
    this.current = flow;
    void this.poll(flow, body.device_code, Number(body.interval ?? 5), expiresAtMs);
    const { state: _state, ...started } = pending;
    return { id: flow.id, ...started };
  }

  status(id: string): DeviceFlowStatus | null {
    return this.current?.id === id ? this.current.status : null;
  }

  cancel(id: string): void {
    if (this.current?.id !== id) return;
    this.current.cancelled = true;
    this.current = null;
  }

  private async poll(
    flow: Flow,
    deviceCode: string,
    intervalSeconds: number,
    expiresAtMs: number,
  ): Promise<void> {
    let interval = intervalSeconds;
    while (!flow.cancelled) {
      await this.sleep(interval * 1000);
      if (flow.cancelled) return;
      if (this.now() >= expiresAtMs) {
        flow.status = { state: "expired" };
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await this.post(ACCESS_TOKEN_URL, {
          client_id: this.deps.clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
      } catch (e) {
        // A dropped connection shouldn't end a sign-in the user may be halfway
        // through; the code's expiry still bounds the retries.
        console.warn("[github] device flow poll failed, retrying:", String(e));
        continue;
      }
      if (flow.cancelled) return;

      if (typeof body.access_token === "string") {
        flow.status = await this.finish(body.access_token);
        return;
      }
      switch (body.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          // GitHub sends the new minimum; adding 5s is what it asks for otherwise.
          interval = Number(body.interval) || interval + 5;
          continue;
        case "expired_token":
          flow.status = { state: "expired" };
          return;
        case "access_denied":
          flow.status = { state: "denied" };
          return;
        default:
          flow.status = { state: "failed", error: describeOAuthError(body, "Sign-in failed") };
          return;
      }
    }
  }

  /** Saves the token, then looks up whose it is. The lookup is only for display. */
  private async finish(token: string): Promise<DeviceFlowStatus> {
    try {
      await this.deps.saveToken(token);
    } catch (e) {
      console.error("[github] saving the signed-in token failed:", String(e));
      const reason = e instanceof Error ? e.message : String(e);
      return { state: "failed", error: `Signed in, but the token couldn't be saved: ${reason}` };
    }
    const login = await this.deps.lookupLogin?.(token).catch(() => null);
    return { state: "authorized", login: login ?? null };
  }

  /** GitHub's OAuth endpoints answer JSON only when asked to. */
  private async post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    if (!res.ok) throw new Error(`github ${new URL(url).pathname} -> ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

/** The page the user is sent to, kept on github.com whatever the response says. */
function githubUri(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_VERIFICATION_URI;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com"
      ? url.toString()
      : DEFAULT_VERIFICATION_URI;
  } catch {
    return DEFAULT_VERIFICATION_URI;
  }
}

function describeOAuthError(body: Record<string, unknown>, fallback: string): string {
  if (body.error === "device_flow_disabled") {
    return "Device flow is turned off for this GitHub OAuth App. Enable it in the app's settings on GitHub.";
  }
  if (body.error === "incorrect_client_credentials") {
    return "GitHub doesn't recognize this build's OAuth client ID.";
  }
  const description = body.error_description ?? body.error;
  return typeof description === "string" ? `${fallback}: ${description}` : fallback;
}
