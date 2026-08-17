import { afterEach, describe, expect, it } from "bun:test";
import { loadConfig } from "../config.ts";

/**
 * Parsing of the YARVIS_MCP_SECRETS env var into `config.mcpSecrets`. No DB
 * required — this exercises the pure config layer.
 */
describe("mcp secrets parsing", () => {
  const original = process.env.YARVIS_MCP_SECRETS;

  afterEach(() => {
    if (original === undefined) delete process.env.YARVIS_MCP_SECRETS;
    else process.env.YARVIS_MCP_SECRETS = original;
  });

  it("parses headers and env keyed by server id", () => {
    process.env.YARVIS_MCP_SECRETS = JSON.stringify({
      s1: { headers: { "X-Api-Key": "secret" }, env: { TOKEN: "t" } },
    });
    const config = loadConfig();
    expect(config.mcpSecrets.s1?.headers).toEqual({ "X-Api-Key": "secret" });
    expect(config.mcpSecrets.s1?.env).toEqual({ TOKEN: "t" });
  });

  it("defaults to an empty map when unset", () => {
    delete process.env.YARVIS_MCP_SECRETS;
    expect(loadConfig().mcpSecrets).toEqual({});
  });

  it("ignores invalid JSON without throwing", () => {
    process.env.YARVIS_MCP_SECRETS = "{not valid";
    expect(loadConfig().mcpSecrets).toEqual({});
  });

  it("drops non-string header and env values", () => {
    process.env.YARVIS_MCP_SECRETS = JSON.stringify({
      s1: { headers: { good: "ok", bad: 5 }, env: { also: "fine", num: 1 } },
    });
    const config = loadConfig();
    expect(config.mcpSecrets.s1?.headers).toEqual({ good: "ok" });
    expect(config.mcpSecrets.s1?.env).toEqual({ also: "fine" });
  });

  it("tolerates a missing env or headers field", () => {
    process.env.YARVIS_MCP_SECRETS = JSON.stringify({ s1: { headers: { a: "b" } } });
    const config = loadConfig();
    expect(config.mcpSecrets.s1?.headers).toEqual({ a: "b" });
    expect(config.mcpSecrets.s1?.env).toEqual({});
  });

  it("parses the oauth subtree", () => {
    process.env.YARVIS_MCP_SECRETS = JSON.stringify({
      s1: {
        oauth: {
          clientId: "cl_1",
          redirectUri: "http://127.0.0.1:5000/oauth/mcp/callback",
          authorizationServerUrl: "https://as.example.com",
          tokenEndpoint: "https://as.example.com/token",
          tokens: { access_token: "at", token_type: "Bearer" },
        },
      },
    });
    const oauth = loadConfig().mcpSecrets.s1?.oauth;
    expect(oauth?.clientId).toBe("cl_1");
    expect(oauth?.redirectUri).toBe("http://127.0.0.1:5000/oauth/mcp/callback");
    expect(oauth?.tokens).toEqual({ access_token: "at", token_type: "Bearer" });
  });

  it("leaves oauth undefined when absent, and drops a non-object one", () => {
    process.env.YARVIS_MCP_SECRETS = JSON.stringify({
      s1: { headers: {} },
      s2: { oauth: "nope" },
    });
    const config = loadConfig();
    expect(config.mcpSecrets.s1?.oauth).toBeUndefined();
    expect(config.mcpSecrets.s2?.oauth).toBeUndefined();
  });

  it("drops non-string oauth fields rather than trusting them", () => {
    process.env.YARVIS_MCP_SECRETS = JSON.stringify({
      s1: { oauth: { clientId: 42, tokens: ["not", "an", "object"] } },
    });
    const oauth = loadConfig().mcpSecrets.s1?.oauth;
    expect(oauth?.clientId).toBeUndefined();
    expect(oauth?.tokens).toBeUndefined();
  });
});
