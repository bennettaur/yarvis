import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  allowedOrigins: null,
  databaseUrl: url,
  secrets: {},
  customProviderSecrets: {},
};
const app = createApp(config);
const jsonAuth = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/json",
};

beforeEach(async () => {
  await sql`TRUNCATE custom_providers RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("custom provider routes", () => {
  it("creates, lists, and updates a provider", async () => {
    const createRes = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "litellm",
        baseUrl: "https://litellm.example.com/v1",
        apiKind: "openai",
        models: ["gpt-4o"],
        headerNames: ["X-Tenant"],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string };
    expect(created.name).toBe("litellm");

    const listRes = await app.request("/api/custom-providers", {
      headers: jsonAuth,
    });
    expect(listRes.status).toBe(200);
    const rows = (await listRes.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(created.id);

    const patchRes = await app.request(`/api/custom-providers/${created.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ models: ["gpt-4o-mini"] }),
    });
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as { models: string[] };
    expect(updated.models).toEqual(["gpt-4o-mini"]);
  });

  it("rejects invalid input", async () => {
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "x", baseUrl: "not-a-url", apiKind: "openai" }),
    });
    expect(res.status).toBe(400);
  });

  it("deletes a provider", async () => {
    const createRes = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "doomed",
        baseUrl: "https://example.com",
        apiKind: "anthropic",
        models: [],
        headerNames: [],
      }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const del = await app.request(`/api/custom-providers/${id}`, {
      method: "DELETE",
      headers: jsonAuth,
    });
    expect(del.status).toBe(204);

    const missing = await app.request(`/api/custom-providers/${id}`, {
      headers: jsonAuth,
    });
    expect(missing.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await app.request("/api/custom-providers");
    expect(res.status).toBe(401);
  });
});
