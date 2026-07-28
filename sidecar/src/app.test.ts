import { describe, expect, it } from "bun:test";
import { createApp } from "./app.ts";
import type { Config } from "./config.ts";
import { createReadiness } from "./readiness.ts";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    allowedOrigins: null,
    databaseUrl: undefined,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
    ...overrides,
  };
}

describe("sidecar app", () => {
  it("serves /health without authentication and reports ready by default", async () => {
    const app = createApp(testConfig());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      ready: boolean;
      phase: string;
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("yarvis-sidecar");
    expect(body.ready).toBe(true);
    expect(body.phase).toBe("ready");
  });

  it("reports not-ready via /health while migrating and on error", async () => {
    const migrating = createApp(testConfig(), createReadiness("migrating"));
    let body = (await (await migrating.request("/health")).json()) as {
      ready: boolean;
      phase: string;
    };
    expect(body.ready).toBe(false);
    expect(body.phase).toBe("migrating");

    const failed = createReadiness("migrating");
    failed.set("error", "connection refused");
    const errored = createApp(testConfig(), failed);
    body = (await (await errored.request("/health")).json()) as {
      ready: boolean;
      phase: string;
      error?: string;
    };
    expect(body.ready).toBe(false);
    expect(body.phase).toBe("error");
    expect((body as { error?: string }).error).toContain("connection refused");
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

  it("mounts the azure routes behind the bearer token", async () => {
    const app = createApp(testConfig());
    // Bearer-gated like the rest of /api/*.
    expect((await app.request("/api/azure/viewer")).status).toBe(401);
    // Authenticated but no database configured: the DB guard runs first.
    const noDb = await app.request("/api/azure/viewer", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(noDb.status).toBe(503);
    // With a database but no Azure credentials, the live route reports not-configured.
    const configured = createApp(testConfig({ databaseUrl: "postgres://localhost/x" }));
    const noCreds = await configured.request("/api/azure/viewer", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(noCreds.status).toBe(400);
  });
});
