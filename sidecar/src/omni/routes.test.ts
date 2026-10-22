import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { createCustomProvider, deleteCustomProvider } from "../customProviders/service.ts";

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: undefined,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {}, // no provider keys configured
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
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

  it("rejects an effort level the SDK doesn't name", async () => {
    const res = await app.request("/api/omni/generate", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        system: "x",
        messages: [{ role: "user", content: "x" }],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "ludicrous",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("streams through a LiteLLM-shaped proxy and sends the chosen effort", async () => {
    // A streamed Responses reply whose reasoning item has no `summary`, as LiteLLM sends one.
    const reasoning = { type: "reasoning", id: "rs_1", content: [], encrypted_content: "sig" };
    const done = {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Here.", annotations: [] }],
    };
    const response = { id: "resp_1", created_at: 0, model: "m", object: "response", output: [] };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: reasoning },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...done, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 1,
        content_index: 0,
        delta: "Here.",
      },
      { type: "response.output_item.done", output_index: 1, item: done },
      {
        type: "response.completed",
        response: {
          ...response,
          status: "completed",
          output: [reasoning, done],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    const bodies: Record<string, unknown>[] = [];
    const gateway = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        bodies.push((await req.json()) as Record<string, unknown>);
        return new Response(
          events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const row = await createCustomProvider({
      name: "litellm",
      baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
      apiKind: "openai",
      models: [{ id: "bedrock-claude-opus-5-5", capabilities: ["chat", "reasoning"] }],
      headerNames: [],
    });
    config.customProviderSecrets[row.id] = { apiKey: "sk-fake", headers: {} };
    try {
      const res = await app.request("/api/omni/generate", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({
          system: "You generate UI.",
          messages: [{ role: "user", content: "show my tasks" }],
          provider: `custom:${row.id}`,
          model: "bedrock-claude-opus-5-5",
          effort: "medium",
        }),
      });
      const stream = await res.text();
      expect(stream).toContain("Here.");
      expect(stream).not.toContain('"type":"error"');
      expect((bodies[0]?.reasoning as { effort?: string } | undefined)?.effort).toBe("medium");
      expect(bodies[0]?.store).toBe(false);
    } finally {
      gateway.stop(true);
      delete config.customProviderSecrets[row.id];
      await deleteCustomProvider(row.id);
    }
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
