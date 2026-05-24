import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  allowedOrigins: null,
  databaseUrl: undefined,
  secrets: {}, // no provider keys configured
};
const app = createApp(config);
const jsonAuth = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/json",
};

describe("omni routes", () => {
  it("rejects a generate request with an invalid body", async () => {
    const res = await app.request("/api/omni/generate", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ messages: [] }), // missing system/provider/model
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the chosen provider has no configured key", async () => {
    const res = await app.request("/api/omni/generate", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        system: "You generate UI.",
        messages: [{ role: "user", content: "show my tasks" }],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Anthropic API key",
    );
  });

  it("requires the bearer token", async () => {
    const res = await app.request("/api/omni/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: "x",
        messages: [{ role: "user", content: "x" }],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 503 for layout routes when no database is configured", async () => {
    const list = await app.request("/api/omni/layouts", { headers: jsonAuth });
    expect(list.status).toBe(503);

    const save = await app.request("/api/omni/layouts", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "x", spec: { root: "r", elements: {} } }),
    });
    expect(save.status).toBe(503);
  });
});
