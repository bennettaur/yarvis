import { describe, expect, it } from "bun:test";
import { createApp } from "./app.ts";
import type { Config } from "./config.ts";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    allowedOrigins: null,
    databaseUrl: undefined,
    secrets: {},
    ...overrides,
  };
}

describe("sidecar app", () => {
  it("serves /health without authentication", async () => {
    const app = createApp(testConfig());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("yarvis-sidecar");
  });

  it("rejects authenticated routes without a bearer token", async () => {
    const app = createApp(testConfig());
    const res = await app.request("/api/status");
    expect(res.status).toBe(401);
  });

  it("rejects authenticated routes with the wrong token", async () => {
    const app = createApp(testConfig());
    const res = await app.request("/api/status", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("allows authenticated routes with the correct token", async () => {
    const app = createApp(testConfig({ databaseUrl: "postgres://localhost/x" }));
    const res = await app.request("/api/status", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { databaseConfigured: boolean };
    expect(body.databaseConfigured).toBe(true);
  });
});
