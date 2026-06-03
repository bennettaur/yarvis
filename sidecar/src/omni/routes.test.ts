import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  allowedOrigins: null,
  databaseUrl: undefined,
  secrets: {}, // no provider keys configured
  customProviderSecrets: {},
  embeddingsSecrets: { headers: {} },
};
const app = createApp(config);
const jsonAuth = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/json",
};

const sampleSpec = {
  root: "root",
  elements: { root: { type: "Tasks", props: {}, children: [] } },
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
    expect(((await res.json()) as { error: string }).error).toContain("Anthropic API key");
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

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const dbApp = createApp({ ...config, databaseUrl: url });

beforeEach(async () => {
  await sql`TRUNCATE omni_layouts RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("omni layout routes (with database)", () => {
  it("saves a layout and lists it as a summary without the spec", async () => {
    const save = await dbApp.request("/api/omni/layouts", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "Dashboard", spec: sampleSpec }),
    });
    expect(save.status).toBe(201);

    const list = await dbApp.request("/api/omni/layouts", { headers: jsonAuth });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Dashboard");
    expect(rows[0]).not.toHaveProperty("spec");
  });

  it("round-trips the full spec on get by id", async () => {
    const save = await dbApp.request("/api/omni/layouts", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "Daily", spec: sampleSpec }),
    });
    const { id } = (await save.json()) as { id: string };

    const get = await dbApp.request(`/api/omni/layouts/${id}`, {
      headers: jsonAuth,
    });
    expect(get.status).toBe(200);
    expect(((await get.json()) as { spec: unknown }).spec).toEqual(sampleSpec);
  });

  it("rejects a layout with a malformed spec", async () => {
    const res = await dbApp.request("/api/omni/layouts", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "Bad", spec: { elements: {} } }), // no root
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-uuid id and 404 for an unknown one", async () => {
    expect(
      (await dbApp.request("/api/omni/layouts/not-a-uuid", { headers: jsonAuth })).status,
    ).toBe(400);

    const missing = "00000000-0000-0000-0000-000000000000";
    expect(
      (await dbApp.request(`/api/omni/layouts/${missing}`, { headers: jsonAuth })).status,
    ).toBe(404);
    expect(
      (
        await dbApp.request(`/api/omni/layouts/${missing}`, {
          method: "DELETE",
          headers: jsonAuth,
        })
      ).status,
    ).toBe(404);
  });

  it("deletes a saved layout", async () => {
    const save = await dbApp.request("/api/omni/layouts", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "Temp", spec: sampleSpec }),
    });
    const { id } = (await save.json()) as { id: string };

    const del = await dbApp.request(`/api/omni/layouts/${id}`, {
      method: "DELETE",
      headers: jsonAuth,
    });
    expect(del.status).toBe(200);
    expect((await dbApp.request(`/api/omni/layouts/${id}`, { headers: jsonAuth })).status).toBe(
      404,
    );
  });
});
