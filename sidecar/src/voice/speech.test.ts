import { describe, expect, it } from "bun:test";
import { assertModelId, OpenAICompatibleSpeech } from "./speech.ts";

/**
 * The OpenAI-compatible client is exercised against a loopback base URL with an
 * injected fetch: loopback literals skip DNS, so these stay offline while still
 * running the real request-building path.
 */
const BASE_URL = "http://127.0.0.1:9099/v1";

interface Captured {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response.clone();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("assertModelId", () => {
  it("accepts Hub-style namespaced ids", () => {
    expect(assertModelId("openai/whisper-large-v3")).toBe("openai/whisper-large-v3");
  });

  it("rejects a model id that would escape the request path", () => {
    expect(() => assertModelId("../../admin")).toThrow(/invalid model id/);
    expect(() => assertModelId("model?query=1")).toThrow(/invalid model id/);
  });
});

describe("OpenAICompatibleSpeech.transcribe", () => {
  it("uploads the audio to /audio/transcriptions and returns the text", async () => {
    const { calls, fetchImpl } = captureFetch(jsonResponse({ text: "  hello there  " }));
    const client = new OpenAICompatibleSpeech({
      baseUrl: `${BASE_URL}/`,
      secrets: { apiKey: "sk-test", headers: { "X-Extra": "1" } },
      fetchImpl,
    });

    const text = await client.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      contentType: "audio/webm;codecs=opus",
      model: "whisper-1",
      language: "en",
    });

    expect(text).toBe("hello there");
    expect(calls).toHaveLength(1);
    // The trailing slash on the base URL must not double up in the path.
    expect(calls[0]!.url).toBe("http://127.0.0.1:9099/v1/audio/transcriptions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["X-Extra"]).toBe("1");
    // Content-Type is left unset so FormData supplies the multipart boundary.
    expect(headers["Content-Type"]).toBeUndefined();

    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("en");
    expect((form.get("file") as File).name).toBe("speech.webm");
  });

  it("reads the text out of a list-shaped response", async () => {
    const { fetchImpl } = captureFetch(jsonResponse([{ text: "hi" }]));
    const client = new OpenAICompatibleSpeech({ baseUrl: BASE_URL, fetchImpl });
    expect(
      await client.transcribe({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
        model: "whisper-1",
      }),
    ).toBe("hi");
  });

  it("surfaces the backend's status and body when it fails", async () => {
    const { fetchImpl } = captureFetch(new Response("model not loaded", { status: 503 }));
    const client = new OpenAICompatibleSpeech({ baseUrl: BASE_URL, fetchImpl });
    await expect(
      client.transcribe({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
        model: "whisper-1",
      }),
    ).rejects.toThrow(/transcription failed \(503\): model not loaded/);
  });

  it("redacts a token echoed back in the error body", async () => {
    const { fetchImpl } = captureFetch(
      new Response("bad key: hf_abcdefghijklmnopqrstuvwxyz", { status: 401 }),
    );
    const client = new OpenAICompatibleSpeech({ baseUrl: BASE_URL, fetchImpl });
    await expect(
      client.transcribe({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
        model: "whisper-1",
      }),
    ).rejects.toThrow(/\[redacted-token\]/);
  });

  it("refuses a non-loopback private address", async () => {
    const { fetchImpl } = captureFetch(jsonResponse({ text: "x" }));
    const client = new OpenAICompatibleSpeech({ baseUrl: "http://10.0.0.5/v1", fetchImpl });
    await expect(
      client.transcribe({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
        model: "whisper-1",
      }),
    ).rejects.toThrow(/private address/);
  });
});

describe("OpenAICompatibleSpeech.synthesize", () => {
  it("posts the text to /audio/speech and returns the audio with its type", async () => {
    const { calls, fetchImpl } = captureFetch(
      new Response(new Uint8Array([9, 9, 9]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      }),
    );
    const client = new OpenAICompatibleSpeech({ baseUrl: BASE_URL, fetchImpl });

    const result = await client.synthesize({ text: "hello", model: "kokoro", voice: "af_bella" });

    expect(result.contentType).toBe("audio/wav");
    expect(Array.from(result.audio)).toEqual([9, 9, 9]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9099/v1/audio/speech");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: "kokoro",
      input: "hello",
      voice: "af_bella",
      response_format: "mp3",
    });
  });

  it("sends a default voice when none is chosen", async () => {
    const { calls, fetchImpl } = captureFetch(new Response(new Uint8Array([1])));
    const client = new OpenAICompatibleSpeech({ baseUrl: BASE_URL, fetchImpl });
    await client.synthesize({ text: "hello", model: "kokoro" });
    expect(JSON.parse(calls[0]!.init.body as string).voice).toBe("alloy");
  });
});
