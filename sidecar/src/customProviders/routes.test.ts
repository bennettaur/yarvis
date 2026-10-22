import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

let dir: string;
let originalPath: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: undefined,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-custom-providers-routes-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  config.customProviderSecrets = {};
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
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
    const updated = (await patchRes.json()) as { models: unknown[] };
    // A bare id is still accepted and reads back as a chat model.
    expect(updated.models).toEqual([{ id: "gpt-4o-mini", capabilities: ["chat"] }]);
  });

  it("rejects invalid input", async () => {
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "x", baseUrl: "not-a-url", apiKind: "openai" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a loopback baseUrl for a local provider (e.g. Ollama)", async () => {
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "ollama",
        baseUrl: "http://localhost:11434/v1",
        apiKind: "openai-chat",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("accepts an ollama-kind provider at the server root", async () => {
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "ollama native",
        baseUrl: "http://localhost:11434",
        apiKind: "ollama",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("still rejects non-loopback private baseUrls", async () => {
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "lan",
        baseUrl: "http://192.168.1.10:11434/v1",
        apiKind: "openai-chat",
      }),
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

  it("saves capability tags per model", async () => {
    const models = [
      { id: "bedrock-claude-opus-5-5", capabilities: ["chat", "vision", "reasoning"] },
      { id: "whisper-1", capabilities: ["stt"] },
    ];
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "litellm",
        baseUrl: "https://litellm.example.com/v1",
        apiKind: "openai",
        models,
      }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { models: unknown }).models).toEqual(models);
  });

  it("rejects a model with no capabilities", async () => {
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "litellm",
        baseUrl: "https://litellm.example.com/v1",
        apiKind: "openai",
        models: [{ id: "gpt-4o", capabilities: [] }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("custom provider connection tests", () => {
  const API_KEY = "sk-test-0123456789abcdef";
  const TENANT = "tenant-secret-value";

  /** A fake proxy on loopback, saved as a provider with `API_KEY` and an `X-Tenant` header. */
  async function providerAt(
    handler: (req: Request) => Response | Promise<Response>,
    apiKind = "openai",
    { path = "/v1", models = ["m1"] as unknown[] } = {},
  ): Promise<string> {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "fake",
        baseUrl: `http://127.0.0.1:${server.port}${path}`,
        apiKind,
        models,
      }),
    });
    const { id } = (await res.json()) as { id: string };
    config.customProviderSecrets[id] = { apiKey: API_KEY, headers: { "X-Tenant": TENANT } };
    return id;
  }

  function post(path: string, body?: unknown): Promise<Response> {
    return Promise.resolve(
      app.request(path, {
        method: "POST",
        headers: jsonAuth,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  it("lists the proxy's models using the saved credentials", async () => {
    const seen: Headers[] = [];
    const id = await providerAt((req) => {
      seen.push(req.headers);
      return Response.json({ data: [{ id: "m1" }, { id: "m2" }] });
    });
    const body = (await (await post(`/api/custom-providers/${id}/test`)).json()) as {
      ok: boolean;
      models: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(["m1", "m2"]);
    expect(seen[0]?.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(seen[0]?.get("x-tenant")).toBe(TENANT);
  });

  it("sends an Anthropic-kind provider's key as x-api-key", async () => {
    const seen: Headers[] = [];
    const id = await providerAt((req) => {
      seen.push(req.headers);
      return Response.json({ data: [{ id: "claude-x" }] });
    }, "anthropic");
    const body = (await (await post(`/api/custom-providers/${id}/test`)).json()) as {
      models: string[];
    };
    expect(body.models).toEqual(["claude-x"]);
    expect(seen[0]?.get("x-api-key")).toBe(API_KEY);
    expect(seen[0]?.get("authorization")).toBeNull();
  });

  it("reports a refused model list as a failed test, with the status", async () => {
    const id = await providerAt(() => Response.json({ error: "bad key" }, { status: 401 }));
    const res = await post(`/api/custom-providers/${id}/test`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string; detail: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("401");
    expect(body.detail).toContain("bad key");
  });

  it("sends a model one prompt through the chat path", async () => {
    const id = await providerAt(() =>
      Response.json({
        id: "resp_1",
        created_at: 0,
        model: "m1",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: " OK ", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    );
    const body = (await (
      await post(`/api/custom-providers/${id}/test-model`, { model: "m1" })
    ).json()) as { ok: boolean; reply: string };
    expect(body).toMatchObject({ ok: true, reply: "OK" });
  });

  it("reports a model the proxy rejects as a failed test", async () => {
    const id = await providerAt(() =>
      Response.json({ error: { message: "model not found" } }, { status: 404 }),
    );
    const body = (await (
      await post(`/api/custom-providers/${id}/test-model`, { model: "nope" })
    ).json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("model not found");
  });

  it("lists an Ollama server's models from /api/tags at the server root", async () => {
    const paths: string[] = [];
    const id = await providerAt(
      (req) => {
        paths.push(new URL(req.url).pathname);
        return Response.json({ models: [{ name: "llama3.2" }] });
      },
      "ollama",
      { path: "" },
    );
    const body = (await (await post(`/api/custom-providers/${id}/test`)).json()) as {
      models: string[];
    };
    expect(paths).toEqual(["/api/tags"]);
    expect(body.models).toEqual(["llama3.2"]);
  });

  it("refuses to follow a redirect to another host, so the credentials stay put", async () => {
    let elsewhereHit = false;
    const elsewhere = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        elsewhereHit = true;
        return Response.json({ data: [] });
      },
    });
    try {
      const id = await providerAt(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${elsewhere.port}/v1/models` },
          }),
      );
      const body = (await (await post(`/api/custom-providers/${id}/test`)).json()) as {
        ok: boolean;
        error: string;
      };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("refused a redirect to another origin");
      expect(elsewhereHit).toBe(false);
    } finally {
      elsewhere.stop(true);
    }
  });

  it("fails, with the body, when the model list isn't JSON", async () => {
    const id = await providerAt(
      () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }),
    );
    const body = (await (await post(`/api/custom-providers/${id}/test`)).json()) as {
      ok: boolean;
      error: string;
      detail: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("wasn't JSON");
    expect(body.detail).toContain("Sign in");
  });

  it("fails when a 200 reply isn't a model list", async () => {
    const id = await providerAt(() => Response.json({ error: { message: "no such route" } }));
    const body = (await (await post(`/api/custom-providers/${id}/test`)).json()) as {
      ok: boolean;
      error: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("wasn't a model list");
  });

  it("scrubs the saved key and header values out of an echoed refusal", async () => {
    const id = await providerAt((req) =>
      Response.json(
        { error: `bad key ${API_KEY} for tenant ${req.headers.get("x-tenant")}` },
        { status: 401 },
      ),
    );
    const text = await (await post(`/api/custom-providers/${id}/test`)).text();
    expect(text).toContain("bad key");
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(TENANT);
  });

  it("tests a model tagged reasoning with an effort", async () => {
    const bodies: Record<string, unknown>[] = [];
    const id = await providerAt(
      async (req) => {
        bodies.push((await req.json()) as Record<string, unknown>);
        return Response.json({
          id: "resp_1",
          created_at: 0,
          model: "m1",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "OK", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
      "openai",
      { models: [{ id: "m1", capabilities: ["chat", "reasoning"] }] },
    );
    await post(`/api/custom-providers/${id}/test-model`, { model: "m1" });
    expect((bodies[0]?.reasoning as { effort?: string } | undefined)?.effort).toBe("low");
  });

  it("rejects a test-model request with no usable model id", async () => {
    const id = await providerAt(() => Response.json({}));
    expect((await post(`/api/custom-providers/${id}/test-model`, {})).status).toBe(400);
    expect((await post(`/api/custom-providers/${id}/test-model`, { model: "a b" })).status).toBe(
      400,
    );
  });

  it("answers 404 for an unknown provider", async () => {
    expect((await post("/api/custom-providers/missing/test")).status).toBe(404);
    expect((await post("/api/custom-providers/missing/test-model", { model: "m" })).status).toBe(
      404,
    );
  });
});
