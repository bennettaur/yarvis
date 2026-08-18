import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

function app(secrets: Partial<Config["secrets"]> = {}): ReturnType<typeof createApp> {
  return createApp({
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
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

  /**
   * Same request with no key configured, so a body that passes validation stops
   * at provider resolution instead of reaching out to the real Hugging Face.
   * "Rejected at the door" and "accepted and then unconfigured" are different
   * messages, which is what lets these assert acceptance without a network call.
   */
  const speakUnconfigured = (body: unknown) =>
    app().request("/api/voice/speak", {
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

  const speakBody = (extra: Record<string, unknown>) => ({
    provider: "huggingface",
    model: "some-model",
    text: "hi",
    ...extra,
  });

  it("rejects a reference clip that is not an audio data URI", async () => {
    // A bare URL here would make the sidecar fetch on the model's behalf.
    expect((await speak(speakBody({ refAudio: "https://example.com/clip.wav" }))).status).toBe(400);
    expect((await speak(speakBody({ refAudio: "data:text/html;base64,AAAA" }))).status).toBe(400);
  });

  it("accepts a well-formed reference clip", async () => {
    // Reaches provider resolution rather than failing validation.
    const res = await speakUnconfigured(speakBody({ refAudio: "data:audio/wav;base64,AAAA" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Hugging Face API key not configured");
  });

  it("refuses extras that would rewrite the model or the text", async () => {
    expect((await speak(speakBody({ extras: { model: "other" } }))).status).toBe(400);
    expect((await speak(speakBody({ extras: { input: "other" } }))).status).toBe(400);
  });

  it("refuses a nested extras value", async () => {
    expect((await speak(speakBody({ extras: { opts: { nested: true } } }))).status).toBe(400);
  });

  it("accepts scalar extras", async () => {
    const res = await speakUnconfigured(
      speakBody({ extras: { response_format: "wav", temperature: 0.5, stream: false } }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Hugging Face API key not configured");
  });
});
