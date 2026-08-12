import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

function app(secrets: Partial<Config["secrets"]> = {}): ReturnType<typeof createApp> {
  return createApp({
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    allowedOrigins: null,
    // No database: the voice routes fall back to the built-in providers, which
    // is all these tests need and keeps them off Postgres.
    databaseUrl: undefined,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets,
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  });
}

const auth = { Authorization: "Bearer test-token" };

function audioRequest(
  query: string,
  body: string | Uint8Array,
  contentType = "audio/webm",
): Request {
  return new Request(`http://localhost/api/voice/transcribe?${query}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": contentType },
    body,
  });
}

describe("GET /api/voice/providers", () => {
  it("requires the bearer token", async () => {
    const res = await app().request("/api/voice/providers");
    expect(res.status).toBe(401);
  });

  it("lists the built-in speech providers", async () => {
    const res = await app({ huggingFaceApiKey: "hf_x" }).request("/api/voice/providers", {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const providers = (await res.json()) as { id: string; available: boolean }[];
    expect(providers.map((p) => p.id)).toContain("huggingface");
    expect(providers.find((p) => p.id === "huggingface")?.available).toBe(true);
  });
});

describe("POST /api/voice/transcribe", () => {
  it("rejects a missing provider or model", async () => {
    const res = await app().request(audioRequest("provider=huggingface", new Uint8Array([1])));
    expect(res.status).toBe(400);
  });

  it("rejects a content type that is not audio", async () => {
    const res = await app({ huggingFaceApiKey: "hf_x" }).request(
      audioRequest("provider=huggingface&model=openai/whisper-large-v3", "{}", "application/json"),
    );
    expect(res.status).toBe(415);
  });

  it("rejects an empty recording before calling a provider", async () => {
    const res = await app({ huggingFaceApiKey: "hf_x" }).request(
      audioRequest("provider=huggingface&model=openai/whisper-large-v3", new Uint8Array()),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty audio" });
  });

  it("explains an unconfigured provider rather than failing at the provider", async () => {
    const res = await app().request(
      audioRequest("provider=huggingface&model=openai/whisper-large-v3", new Uint8Array([1, 2])),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Hugging Face API key not configured");
  });

  it("rejects a malformed language hint", async () => {
    const res = await app({ huggingFaceApiKey: "hf_x" }).request(
      audioRequest(
        "provider=huggingface&model=openai/whisper-large-v3&language=english",
        new Uint8Array([1]),
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/voice/speak", () => {
  const speak = (body: unknown) =>
    app({ huggingFaceApiKey: "hf_x" }).request("/api/voice/speak", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("rejects an empty body", async () => {
    expect((await speak({})).status).toBe(400);
  });

  it("rejects text past the per-call limit", async () => {
    const res = await speak({
      provider: "huggingface",
      model: "hexgrad/Kokoro-82M",
      text: "a".repeat(5000),
    });
    expect(res.status).toBe(400);
  });

  it("explains an unconfigured provider", async () => {
    const res = await app().request("/api/voice/speak", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "huggingface", model: "hexgrad/Kokoro-82M", text: "hi" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Hugging Face API key not configured");
  });
});
