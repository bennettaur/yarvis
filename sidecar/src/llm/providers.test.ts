import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { createCustomProvider } from "../customProviders/service.ts";
import {
  CUSTOM_PROVIDER_PREFIX,
  availableProviders,
  resolveModel,
} from "./providers.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const { db } = getDb(url);

function configWithSecrets(
  secrets: Config["customProviderSecrets"] = {},
): Config {
  return {
    port: 0,
    token: "t",
    tokenGenerated: false,
    allowedOrigins: null,
    databaseUrl: url,
    secrets: {},
    customProviderSecrets: secrets,
  };
}

beforeEach(async () => {
  await sql`TRUNCATE custom_providers RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("availableProviders", () => {
  it("returns only built-ins when no database is provided", async () => {
    const providers = await availableProviders(configWithSecrets());
    expect(providers.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "bedrock",
      "gemini",
    ]);
  });

  it("appends configured custom providers when given a database", async () => {
    const row = await createCustomProvider(db, {
      name: "litellm",
      baseUrl: "https://litellm.example.com/v1",
      apiKind: "openai",
      models: ["gpt-4o", "claude-via-proxy"],
      headerNames: ["X-Tenant"],
    });
    const providers = await availableProviders(configWithSecrets(), db);
    const custom = providers.find((p) => p.id === `${CUSTOM_PROVIDER_PREFIX}${row.id}`);
    expect(custom?.label).toBe("litellm");
    expect(custom?.models).toEqual(["gpt-4o", "claude-via-proxy"]);
    expect(custom?.custom).toBe(true);
    expect(custom?.available).toBe(true);
  });

  it("marks a custom provider unavailable when it has no models", async () => {
    const row = await createCustomProvider(db, {
      name: "empty",
      baseUrl: "https://empty.example.com",
      apiKind: "openai",
      models: [],
      headerNames: [],
    });
    const providers = await availableProviders(configWithSecrets(), db);
    expect(
      providers.find((p) => p.id === `${CUSTOM_PROVIDER_PREFIX}${row.id}`)?.available,
    ).toBe(false);
  });
});

describe("resolveModel for custom providers", () => {
  it("builds an openai-kind model from the row plus stored secrets", async () => {
    const row = await createCustomProvider(db, {
      name: "litellm",
      baseUrl: "https://litellm.example.com/v1",
      apiKind: "openai",
      models: ["gpt-4o"],
      headerNames: ["X-Tenant"],
    });
    const config = configWithSecrets({
      [row.id]: { apiKey: "sk-fake", headers: { "X-Tenant": "team-a" } },
    });
    const model = await resolveModel(
      config,
      db,
      `${CUSTOM_PROVIDER_PREFIX}${row.id}`,
      "gpt-4o",
    );
    expect((model as { modelId?: string }).modelId).toBe("gpt-4o");
  });

  it("builds an openai-chat model targeting /chat/completions", async () => {
    const row = await createCustomProvider(db, {
      name: "litellm-chat",
      baseUrl: "https://litellm.example.com/v1",
      apiKind: "openai-chat",
      models: ["gpt-4o"],
      headerNames: [],
    });
    const model = await resolveModel(
      configWithSecrets(),
      db,
      `${CUSTOM_PROVIDER_PREFIX}${row.id}`,
      "gpt-4o",
    );
    expect((model as { modelId?: string }).modelId).toBe("gpt-4o");
  });

  it("builds an anthropic-kind model when the row declares it", async () => {
    const row = await createCustomProvider(db, {
      name: "litellm-anthropic",
      baseUrl: "https://litellm.example.com/anthropic",
      apiKind: "anthropic",
      models: ["claude-sonnet-4-6"],
      headerNames: [],
    });
    const model = await resolveModel(
      configWithSecrets(),
      db,
      `${CUSTOM_PROVIDER_PREFIX}${row.id}`,
      "claude-sonnet-4-6",
    );
    expect((model as { modelId?: string }).modelId).toBe("claude-sonnet-4-6");
  });

  it("throws when the custom provider id is unknown", async () => {
    await expect(
      resolveModel(
        configWithSecrets(),
        db,
        `${CUSTOM_PROVIDER_PREFIX}does-not-exist`,
        "x",
      ),
    ).rejects.toThrow();
  });
});
