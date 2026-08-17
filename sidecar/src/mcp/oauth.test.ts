import { describe, expect, it } from "bun:test";
import type { OAuthTokens } from "@ai-sdk/mcp";
import type { Config } from "../config.ts";
import type { McpServerRow } from "../db/schema.ts";
import {
  consumeOAuthState,
  forgetOAuthProvider,
  getOAuthProvider,
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
    expect(provider.status()).toMatchObject({ authorized: true, authorizationUrl: null });
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
    expect(provider.status()).toEqual({
      registered: false,
      authorized: false,
      scope: null,
      authorizationUrl: null,
    });
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
