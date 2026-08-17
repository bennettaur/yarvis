import { describe, expect, it } from "bun:test";
import { type OAuthTokens, UnauthorizedError } from "@ai-sdk/mcp";
import type { Config } from "../config.ts";
import type { McpServerRow } from "../db/schema.ts";
import {
  consumeOAuthState,
  discoverProtectedResourceScopes,
  forgetOAuthProvider,
  getOAuthProvider,
  isUnauthorized,
  McpOAuthProvider,
  oauthRedirectUri,
} from "./oauth.ts";

/**
 * The MCP OAuth provider's own bookkeeping. No DB and no network: persistence
 * goes through the core control channel, which is absent here, so every write
 * falls back to the in-memory copy these assertions read.
 */

const REDIRECT = "http://127.0.0.1:5000/oauth/mcp/callback";

function tokens(accessToken: string): OAuthTokens {
  return { access_token: accessToken, token_type: "Bearer" };
}

function server(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "locker",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    command: null,
    args: [],
    headerNames: [],
    oauth: true,
    oauthScope: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 5000,
    token: "t",
    tokenGenerated: false,
    attentionToken: "a",
    mcpToken: "m",
    allowedOrigins: null,
    databaseUrl: undefined,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
    ...overrides,
  } as Config;
}

describe("McpOAuthProvider", () => {
  it("registers as a public client on the current redirect uri", () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, "api:read", undefined);
    const metadata = provider.clientMetadata;
    expect(metadata.redirect_uris).toEqual([REDIRECT]);
    expect(metadata.token_endpoint_auth_method).toBe("none");
    expect(metadata.scope).toBe("api:read");
    expect(metadata.grant_types).toContain("refresh_token");
  });

  it("omits scope entirely when none is configured", () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, undefined);
    expect(provider.clientMetadata.scope).toBeUndefined();
  });

  it("reuses a registration made on the same redirect uri", () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, {
      clientId: "cl_1",
      redirectUri: REDIRECT,
      tokens: { access_token: "at", token_type: "Bearer" },
    });
    expect(provider.clientInformation()?.client_id).toBe("cl_1");
    expect(provider.tokens()?.access_token).toBe("at");
  });

  it("discards a registration made on a different port, tokens included", () => {
    // The sidecar picks a new loopback port each app launch, so the stored
    // registration can no longer receive a callback and has to be redone.
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, {
      clientId: "cl_1",
      redirectUri: "http://127.0.0.1:4999/oauth/mcp/callback",
      tokens: { access_token: "at", token_type: "Bearer" },
    });
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.tokens()).toBeUndefined();
  });

  it("records the registration's redirect uri when saving client information", async () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, undefined);
    await provider.saveClientInformation({ client_id: "cl_2" });
    expect(provider.clientInformation()?.client_id).toBe("cl_2");
    expect(provider.status().registered).toBe(true);
  });

  it("captures the authorization url instead of opening a browser", () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, undefined);
    expect(provider.authorizationUrl).toBeNull();
    provider.redirectToAuthorization(new URL("https://as.example.com/authorize?client_id=cl"));
    expect(provider.authorizationUrl).toBe("https://as.example.com/authorize?client_id=cl");
  });

  it("clears the pending authorization url once tokens arrive", async () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, undefined);
    provider.redirectToAuthorization(new URL("https://as.example.com/authorize"));
    await provider.saveTokens(tokens("at"));
    expect(provider.authorizationUrl).toBeNull();
    expect(provider.status()).toMatchObject({ authorized: true });
  });

  it("keeps the code verifier only in memory and refuses to invent one", () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, undefined);
    expect(() => provider.codeVerifier()).toThrow(/code verifier/);
    provider.saveCodeVerifier("verifier");
    expect(provider.codeVerifier()).toBe("verifier");
  });

  it("drops only the requested half when credentials are invalidated", async () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, {
      clientId: "cl_1",
      redirectUri: REDIRECT,
      tokens: { access_token: "at", token_type: "Bearer" },
    });
    await provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()?.client_id).toBe("cl_1");

    await provider.invalidateCredentials("all");
    expect(provider.clientInformation()).toBeUndefined();
  });

  it("forgets everything when cleared", async () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, {
      clientId: "cl_1",
      redirectUri: REDIRECT,
      tokens: { access_token: "at", token_type: "Bearer" },
    });
    await provider.clear();
    expect(provider.status()).toEqual({ registered: false, authorized: false, scope: null });
  });
});

describe("scope discovery", () => {
  const prm = (scopes: unknown) =>
    new Response(JSON.stringify({ scopes_supported: scopes }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const fetchStub = (handler: (url: string) => Response): typeof globalThis.fetch =>
    Object.assign(async (input: string | URL | Request) => handler(String(input)), {
      preconnect: globalThis.fetch.preconnect,
    }) as typeof globalThis.fetch;

  it("prefers the path-scoped metadata document", async () => {
    const seen: string[] = [];
    const scope = await discoverProtectedResourceScopes(
      "https://mcp.example.com/mcp",
      fetchStub((url) => {
        seen.push(url);
        return prm(["api:read", "tools:execute"]);
      }),
    );
    expect(seen[0]).toBe("https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
    expect(scope).toBe("api:read tools:execute");
  });

  it("falls back to the origin-wide document when the path-scoped one is missing", async () => {
    const scope = await discoverProtectedResourceScopes(
      "https://mcp.example.com/mcp",
      fetchStub((url) =>
        url.endsWith("/mcp") ? new Response("nope", { status: 404 }) : prm(["api:read"]),
      ),
    );
    expect(scope).toBe("api:read");
  });

  it("returns nothing when neither document answers, rather than failing", async () => {
    const scope = await discoverProtectedResourceScopes(
      "https://mcp.example.com/mcp",
      fetchStub(() => new Response("nope", { status: 404 })),
    );
    expect(scope).toBeUndefined();
  });

  it("survives a document that isn't JSON", async () => {
    const scope = await discoverProtectedResourceScopes(
      "https://mcp.example.com/mcp",
      fetchStub(() => new Response("<html>", { status: 200 })),
    );
    expect(scope).toBeUndefined();
  });

  it("ignores a scopes_supported that isn't a list of strings", async () => {
    const scope = await discoverProtectedResourceScopes(
      "https://mcp.example.com/mcp",
      fetchStub(() => prm("api:read")),
    );
    expect(scope).toBeUndefined();
  });
});

describe("discovered scopes on the provider", () => {
  it("asks for the discovered scopes when none are configured", () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, undefined);
    expect(provider.needsScopeDiscovery()).toBe(true);
    provider.setDiscoveredScope("api:read tools:execute");
    expect(provider.clientMetadata.scope).toBe("api:read tools:execute");
    expect(provider.needsScopeDiscovery()).toBe(false);
  });

  it("lets a configured scope win, and skips discovery entirely", () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, "api:read", undefined);
    expect(provider.needsScopeDiscovery()).toBe(false);
    provider.setDiscoveredScope("api:read api:write tools:execute");
    expect(provider.clientMetadata.scope).toBe("api:read");
  });

  it("discards a registration made before the scopes were known", () => {
    // The bug this exists for: registering with no scope yields a token the
    // server accepts at authorization time and then refuses on every request.
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, {
      clientId: "cl_1",
      redirectUri: REDIRECT,
      tokens: { access_token: "at", token_type: "Bearer" },
    });
    expect(provider.clientInformation()?.client_id).toBe("cl_1");
    provider.setDiscoveredScope("api:read");
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.tokens()).toBeUndefined();
  });

  it("keeps a registration that already asked for those scopes", () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, {
      clientId: "cl_1",
      redirectUri: REDIRECT,
      scope: "api:read",
      tokens: { access_token: "at", token_type: "Bearer" },
    });
    provider.setDiscoveredScope("api:read");
    expect(provider.clientInformation()?.client_id).toBe("cl_1");
    expect(provider.tokens()?.access_token).toBe("at");
  });

  it("keeps a registration when discovery turns up nothing", () => {
    // Discovery failing must not look like a scope change and wipe a good token.
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, {
      clientId: "cl_1",
      redirectUri: REDIRECT,
      scope: "api:read",
      tokens: { access_token: "at", token_type: "Bearer" },
    });
    provider.setDiscoveredScope(undefined);
    expect(provider.clientInformation()?.client_id).toBe("cl_1");
    expect(provider.tokens()?.access_token).toBe("at");
  });

  it("records the scopes it registered with", async () => {
    const provider = new McpOAuthProvider("s1", REDIRECT, undefined, undefined);
    provider.setDiscoveredScope("api:read");
    await provider.saveClientInformation({ client_id: "cl_2" });
    // Re-reading with the same discovered scope must not discard it.
    provider.setDiscoveredScope("api:read");
    expect(provider.clientInformation()?.client_id).toBe("cl_2");
  });
});

describe("isUnauthorized", () => {
  it("recognises the client library's own unauthorized error", () => {
    expect(isUnauthorized(new UnauthorizedError())).toBe(true);
  });

  it("finds one the transport wrapped as a cause", () => {
    // The transport rethrows whatever the failing request produced, so the
    // needs-authorization signal arrives buried rather than at the top.
    const wrapped = new Error("initialize failed", {
      cause: new Error("POST failed", { cause: new UnauthorizedError() }),
    });
    expect(isUnauthorized(wrapped)).toBe(true);
  });

  it("does not mistake an ordinary failure for one", () => {
    expect(isUnauthorized(new Error("connection refused"))).toBe(false);
    expect(isUnauthorized(undefined)).toBe(false);
  });

  it("gives up rather than looping on a self-referencing cause chain", () => {
    const a = new Error("a");
    a.cause = a;
    expect(isUnauthorized(a)).toBe(false);
  });
});

describe("authorization state", () => {
  it("resolves a saved state back to its server, once", () => {
    const provider = new McpOAuthProvider("s-state", REDIRECT, undefined, undefined);
    const state = provider.state();
    provider.saveState(state);
    expect(consumeOAuthState(state)).toBe("s-state");
    expect(consumeOAuthState(state)).toBeNull();
  });

  it("refuses a state it never issued", () => {
    expect(consumeOAuthState("not-a-real-state")).toBeNull();
  });
});

describe("getOAuthProvider", () => {
  it("builds nothing for a server that hasn't opted in", () => {
    expect(getOAuthProvider(config(), server({ oauth: false }))).toBeUndefined();
  });

  it("builds nothing for a stdio server, which has no http layer to authorize", () => {
    expect(
      getOAuthProvider(config(), server({ transport: "stdio", command: "npx", url: null })),
    ).toBeUndefined();
  });

  it("caches one provider per server so a flow spans both requests", () => {
    const row = server();
    const first = getOAuthProvider(config(), row);
    expect(getOAuthProvider(config(), row)).toBe(first!);
    forgetOAuthProvider(row.id);
    expect(getOAuthProvider(config(), row)).not.toBe(first!);
    forgetOAuthProvider(row.id);
  });

  it("rebuilds when the loopback port changes", () => {
    const row = server();
    const first = getOAuthProvider(config({ port: 5000 }), row);
    const second = getOAuthProvider(config({ port: 5001 }), row);
    expect(second).not.toBe(first!);
    expect(second?.redirectUrl).toBe("http://127.0.0.1:5001/oauth/mcp/callback");
    forgetOAuthProvider(row.id);
  });

  it("rebuilds when the requested scope changes", () => {
    const row = server();
    const first = getOAuthProvider(config(), row);
    const second = getOAuthProvider(config(), server({ oauthScope: "api:read" }));
    expect(second).not.toBe(first!);
    expect(second?.clientMetadata.scope).toBe("api:read");
    forgetOAuthProvider(row.id);
  });
});

describe("oauthRedirectUri", () => {
  it("points at the sidecar's own loopback port", () => {
    expect(oauthRedirectUri(config({ port: 61234 }))).toBe(
      "http://127.0.0.1:61234/oauth/mcp/callback",
    );
  });
});
