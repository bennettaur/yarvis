import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@ai-sdk/mcp";
import type { Config, McpOAuthCredentials } from "../config.ts";
import { saveMcpOAuth } from "../core/controlClient.ts";
import type { McpServerRow } from "../db/schema.ts";

/**
 * The MCP authorization flow (OAuth 2.1 + PKCE) for HTTP servers, as the client
 * library's `OAuthClientProvider` contract.
 *
 * Two stores, deliberately split by lifetime:
 *
 *   - Durable — the dynamically registered client, the authorization server it
 *     was registered with, and the issued tokens. These go to the macOS Keychain
 *     through the core's control channel, and come back on the next launch in
 *     `YARVIS_MCP_SECRETS`. Tokens refresh on their own schedule, so the write
 *     path has to work without restarting the sidecar — which is why it is a
 *     control-channel call rather than the Tauri command the other MCP secrets
 *     use.
 *   - In-flight — the PKCE code verifier, the CSRF `state`, and the URL the user
 *     has to visit. One authorization completes inside a single sidecar run, so
 *     these stay in memory and a restart simply means starting over.
 *
 * The provider never opens a browser itself: the sidecar has no UI. It captures
 * the authorization URL and the route that triggered the flow hands it to the
 * frontend, which opens it.
 */

/** Client name presented to an authorization server during registration. */
const CLIENT_NAME = "Yarvis";

/** Bound on remembered `state` values, and how long an unfinished flow lives. */
const STATE_TTL_MS = 5 * 60_000;
const MAX_PENDING_STATES = 64;

/** Path the loopback redirect lands on, mounted outside the bearer wall. */
export const OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";

export function oauthRedirectUri(config: Config): string {
  return `http://127.0.0.1:${config.port}${OAUTH_CALLBACK_PATH}`;
}

/** Maps a callback's `state` back to the server whose flow issued it. */
const statesToServerId = new Map<string, { serverId: string; issuedAt: number }>();

function rememberState(state: string, serverId: string): void {
  const now = Date.now();
  for (const [key, entry] of statesToServerId) {
    if (now - entry.issuedAt > STATE_TTL_MS) statesToServerId.delete(key);
  }
  while (statesToServerId.size >= MAX_PENDING_STATES) {
    const oldest = statesToServerId.keys().next().value;
    if (oldest === undefined) break;
    statesToServerId.delete(oldest);
  }
  statesToServerId.set(state, { serverId, issuedAt: now });
}

/** Resolves and consumes a callback `state`; null when unknown or expired. */
export function consumeOAuthState(state: string): string | null {
  const entry = statesToServerId.get(state);
  if (!entry) return null;
  statesToServerId.delete(state);
  return Date.now() - entry.issuedAt <= STATE_TTL_MS ? entry.serverId : null;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface McpOAuthStatus {
  /** Whether a client is registered with the authorization server. */
  registered: boolean;
  /** Whether an access token is held. */
  authorized: boolean;
  /** Scopes the authorization server granted, when it said. */
  scope: string | null;
}

export class McpOAuthProvider {
  private credentials: McpOAuthCredentials;
  private codeVerifierValue: string | undefined;
  private stateValue: string | undefined;
  private pendingAuthorizationUrl: string | null = null;

  constructor(
    private readonly serverId: string,
    private readonly redirectUri: string,
    private readonly scope: string | undefined,
    seed: McpOAuthCredentials | undefined,
  ) {
    this.credentials = { ...(seed ?? {}) };
    // A registration is bound to the redirect URI it was made with, and ours
    // carries the sidecar's port — which is picked fresh each app launch. Drop a
    // registration from a previous port (and the tokens it issued) so `auth()`
    // sees no client and registers again against the port we can actually
    // receive a callback on.
    if (this.credentials.clientId && this.credentials.redirectUri !== redirectUri) {
      this.credentials = {};
    }
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Yarvis is a native app and cannot keep a client secret, so it registers
      // as a public client and leans on PKCE.
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    const { clientId, clientSecret, authorizationServerUrl, tokenEndpoint } = this.credentials;
    if (!clientId) return undefined;
    return {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      ...(authorizationServerUrl ? { authorization_server: authorizationServerUrl } : {}),
      ...(tokenEndpoint ? { token_endpoint: tokenEndpoint } : {}),
    };
  }

  async saveClientInformation(info: OAuthClientInformation): Promise<void> {
    this.credentials = {
      ...this.credentials,
      clientId: info.client_id,
      clientSecret: info.client_secret,
      redirectUri: this.redirectUri,
      authorizationServerUrl: info.authorization_server ?? this.credentials.authorizationServerUrl,
      tokenEndpoint: info.token_endpoint ?? this.credentials.tokenEndpoint,
    };
    await this.persist();
  }

  authorizationServerInformation(): OAuthAuthorizationServerInformation | undefined {
    const { authorizationServerUrl, tokenEndpoint } = this.credentials;
    if (!authorizationServerUrl || !tokenEndpoint) return undefined;
    return { authorizationServerUrl, tokenEndpoint };
  }

  async saveAuthorizationServerInformation(
    info: OAuthAuthorizationServerInformation,
  ): Promise<void> {
    this.credentials = {
      ...this.credentials,
      authorizationServerUrl: info.authorizationServerUrl,
      tokenEndpoint: info.tokenEndpoint,
    };
    await this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.credentials.tokens as OAuthTokens | undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.credentials = { ...this.credentials, tokens: tokens as Record<string, unknown> };
    this.pendingAuthorizationUrl = null;
    await this.persist();
  }

  /**
   * Called by the client library when the server rejects what we hold. Dropping
   * the bad half locally lets the retry inside `auth()` re-register or
   * re-authorize instead of failing back to the user.
   */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "all") this.credentials = {};
    if (scope === "client") {
      this.credentials = { ...this.credentials, clientId: undefined, clientSecret: undefined };
    }
    if (scope === "tokens") this.credentials = { ...this.credentials, tokens: undefined };
    if (scope === "verifier") {
      this.codeVerifierValue = undefined;
      return;
    }
    await this.persist();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error("no PKCE code verifier for this authorization; start the flow again");
    }
    return this.codeVerifierValue;
  }

  state(): string {
    const state = randomState();
    this.stateValue = state;
    return state;
  }

  saveState(state: string): void {
    this.stateValue = state;
    rememberState(state, this.serverId);
  }

  storedState(): string | undefined {
    return this.stateValue;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuthorizationUrl = authorizationUrl.href;
  }

  /**
   * The authorization URL captured by the last flow that needed one. Reading it
   * does not clear it: the user may need it again if they close the browser tab
   * before consenting.
   */
  get authorizationUrl(): string | null {
    return this.pendingAuthorizationUrl;
  }

  status(): McpOAuthStatus {
    const tokens = this.tokens();
    return {
      registered: Boolean(this.credentials.clientId),
      authorized: Boolean(tokens?.access_token),
      scope: tokens?.scope ?? null,
    };
  }

  /** Forgets everything, locally and in the Keychain. */
  async clear(): Promise<void> {
    this.credentials = {};
    this.codeVerifierValue = undefined;
    this.stateValue = undefined;
    this.pendingAuthorizationUrl = null;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const empty = Object.values(this.credentials).every((v) => v === undefined);
    try {
      await saveMcpOAuth(this.serverId, empty ? null : this.credentials);
    } catch (error) {
      // A standalone sidecar (`sidecar:dev`, tests) has no core to write to.
      // Authorization still works for this run; it just won't survive a restart.
      console.warn(
        `[mcp] could not persist OAuth credentials for ${this.serverId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * One provider per server, cached for the process lifetime: an authorization
 * spans two HTTP requests (the one that starts it and the loopback callback),
 * and the PKCE verifier linking them only lives on the provider.
 *
 * Rebuilt when the redirect URI or requested scope changes, so a restart on a
 * new port doesn't keep using a provider bound to the old one.
 */
const providers = new Map<string, { provider: McpOAuthProvider; key: string }>();

export function getOAuthProvider(
  config: Config,
  server: McpServerRow,
): McpOAuthProvider | undefined {
  if (!server.oauth || server.transport !== "http") return undefined;
  const redirectUri = oauthRedirectUri(config);
  const scope = server.oauthScope?.trim() || undefined;
  const key = `${redirectUri}|${scope ?? ""}`;
  const cached = providers.get(server.id);
  if (cached && cached.key === key) return cached.provider;
  const provider = new McpOAuthProvider(
    server.id,
    redirectUri,
    scope,
    config.mcpSecrets[server.id]?.oauth,
  );
  providers.set(server.id, { provider, key });
  return provider;
}

/** Drops a server's cached provider, e.g. when the server itself is deleted. */
export function forgetOAuthProvider(serverId: string): void {
  providers.delete(serverId);
  for (const [state, entry] of statesToServerId) {
    if (entry.serverId === serverId) statesToServerId.delete(state);
  }
}
