import { afterEach, describe, expect, it, mock } from "bun:test";
import * as api from "./api";

/**
 * The transport is stubbed by spreading the real `./api` and replacing only
 * `sidecarFetch`, so `ensureOk`'s real behavior still applies here and nothing
 * is taken away from test files that run after this one.
 */

interface Recorded {
  path: string;
  init: RequestInit;
}

const requests: Recorded[] = [];
let nextResponse: () => Response = () => new Response("{}");

mock.module("./api", () => ({
  ...api,
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    requests.push({ path, init });
    return nextResponse();
  },
}));

const { listVoiceProviders, speak, transcribe } = await import("./voice");

afterEach(() => {
  requests.length = 0;
  nextResponse = () => new Response("{}");
});

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("transcribe", () => {
  it("sends the recording's own content type", async () => {
    nextResponse = () => json({ text: "hello" });
    const audio = new Blob(["x"], { type: "audio/webm;codecs=opus" });

    expect(await transcribe({ provider: "huggingface", model: "whisper-1", audio })).toBe("hello");
    const headers = new Headers(requests[0]!.init.headers);
    expect(headers.get("Content-Type")).toBe("audio/webm;codecs=opus");
  });

  it("falls back to audio/webm when the recorder left the type blank", async () => {
    nextResponse = () => json({ text: "hello" });
    // A MediaRecorder blob can arrive with an empty type; sending that would
    // hit the route's content-type allowlist and come back 415.
    const audio = new Blob(["x"]);

    await transcribe({ provider: "huggingface", model: "whisper-1", audio });
    expect(new Headers(requests[0]!.init.headers).get("Content-Type")).toBe("audio/webm");
  });

  it("passes the provider, model and language as query parameters", async () => {
    nextResponse = () => json({ text: "hola" });
    const audio = new Blob(["x"], { type: "audio/webm" });

    await transcribe({ provider: "custom:abc", model: "whisper-1", audio, language: "es" });
    const query = new URLSearchParams(requests[0]!.path.split("?")[1]);
    expect(query.get("provider")).toBe("custom:abc");
    expect(query.get("model")).toBe("whisper-1");
    expect(query.get("language")).toBe("es");
  });

  it("omits the language entirely when none is set", async () => {
    nextResponse = () => json({ text: "hi" });
    await transcribe({
      provider: "huggingface",
      model: "whisper-1",
      audio: new Blob(["x"], { type: "audio/webm" }),
    });
    expect(requests[0]!.path).not.toContain("language");
  });

  it("surfaces the sidecar's reason when it refuses", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ error: "Hugging Face API key not configured" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });

    await expect(
      transcribe({
        provider: "huggingface",
        model: "whisper-1",
        audio: new Blob(["x"], { type: "audio/webm" }),
      }),
    ).rejects.toThrow(/Hugging Face API key not configured/);
  });
});

describe("speak", () => {
  it("posts the chunk and returns the audio", async () => {
    nextResponse = () =>
      new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } });

    const blob = await speak({
      provider: "huggingface",
      model: "hexgrad/Kokoro-82M",
      text: "hello",
      voice: "af_bella",
    });

    expect(blob.size).toBe(2);
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
      provider: "huggingface",
      model: "hexgrad/Kokoro-82M",
      text: "hello",
      voice: "af_bella",
    });
  });
});

describe("listVoiceProviders", () => {
  it("returns the catalog", async () => {
    const catalog = [
      {
        id: "huggingface",
        label: "Hugging Face",
        available: true,
        // Transcription only: the serverless router refuses every TTS model.
        capabilities: ["stt" as const],
        sttModels: ["openai/whisper-large-v3-turbo"],
        ttsModels: [],
      },
    ];
    nextResponse = () => json(catalog);
    expect(await listVoiceProviders()).toEqual(catalog);
  });
});
