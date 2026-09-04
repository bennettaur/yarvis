import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { resolveComplexityModel } from "./complexity.ts";

/** Covers the round trip every specialist that opts into a tier depends on. */

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

/**
 * `null` means "no database configured". Not `undefined`: passing that
 * explicitly would trigger the default parameter and quietly give the app a
 * database, which is the opposite of what those tests are checking.
 */
function testConfig(databaseUrl: string | null): Config {
  return {
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl: databaseUrl ?? undefined,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  };
}

function app(databaseUrl: string | null = url): ReturnType<typeof createApp> {
  return createApp(testConfig(databaseUrl));
}

const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

const patch = (body: unknown, target = app()) =>
  target.request("/api/complexity-models", {
    method: "PATCH",
    headers: jsonAuth,
    body: JSON.stringify(body),
  });

const read = (target = app()) => target.request("/api/complexity-models", { headers: auth });

beforeEach(async () => {
  await sql`TRUNCATE complexity_model_config RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("complexity model config", () => {
  it("requires the bearer token", async () => {
    expect((await app().request("/api/complexity-models")).status).toBe(401);
  });

  it("answers all tiers unset before anything is configured", async () => {
    const body = (await (await read()).json()) as Record<string, unknown>;
    expect(body).toEqual({ low: null, medium: null, max: null });
  });

  it("saves and reads back one tier, leaving the others unset", async () => {
    const saved = await patch({ low: { provider: "cerebras", model: "llama-3.3-70b" } });
    expect(saved.status).toBe(200);

    const body = (await (await read()).json()) as Record<string, unknown>;
    expect(body.low).toEqual({ provider: "cerebras", model: "llama-3.3-70b" });
    expect(body.medium).toBeNull();
    expect(body.max).toBeNull();
  });

  it("keeps one row across repeated saves", async () => {
    await patch({ low: { provider: "cerebras", model: "llama-3.3-70b" } });
    await patch({ medium: { provider: "anthropic", model: "claude-haiku-4-5" } });

    const [{ count }] = await sql<
      { count: string }[]
    >`SELECT count(*) FROM complexity_model_config`;
    expect(Number(count)).toBe(1);
    // A later save must not wipe what an earlier one set.
    const body = (await (await read()).json()) as Record<string, unknown>;
    expect(body.low).toEqual({ provider: "cerebras", model: "llama-3.3-70b" });
    expect(body.medium).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("clears a tier by saving it as null", async () => {
    await patch({ low: { provider: "cerebras", model: "llama-3.3-70b" } });
    await patch({ low: null });

    const body = (await (await read()).json()) as Record<string, unknown>;
    expect(body.low).toBeNull();
  });

  it("rejects an incomplete selection", async () => {
    expect((await patch({ low: { provider: "cerebras" } })).status).toBe(400);
  });

  it("serves all-unset rather than failing when there is no database", async () => {
    const res = await read(app(null));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ low: null, medium: null, max: null });
  });

  it("refuses to save with no database", async () => {
    expect((await patch({ low: { provider: "x", model: "y" } }, app(null))).status).toBe(503);
  });
});

describe("resolveComplexityModel", () => {
  const config = testConfig(url);
  const db = getDb(url).db;

  it("returns the configured tier's model verbatim", async () => {
    await patch({ low: { provider: "cerebras", model: "llama-3.3-70b" } });
    expect(await resolveComplexityModel(config, db, "low")).toEqual({
      provider: "cerebras",
      model: "llama-3.3-70b",
    });
  });

  it("falls back to the default chat model when the tier is unset", async () => {
    // No provider secrets configured, so there is no default to fall back to —
    // the point being it *falls back* rather than throwing or inventing one.
    expect(await resolveComplexityModel(config, db, "medium")).toBeNull();
  });
});
