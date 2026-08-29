import { describe, expect, it } from "bun:test";
import {
  assertModelId,
  GeminiSpeech,
  HuggingFaceSpeech,
  MAX_TRANSCRIPT_CHARS,
  OpenAICompatibleSpeech,
  pcmSampleRate,
  pcmToWav,
  SpeechValidationError,
} from "./speech.ts";

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

/**
 * Answers each call from `responses` in order, so a redirect chain can be
 * played out one hop at a time.
 */
function scriptedFetch(responses: Response[]): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const res = responses[Math.min(index++, responses.length - 1)]!;
    return res.clone();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

const transcribeArgs = {
  audio: new Uint8Array([1]),
  contentType: "audio/wav",
  model: "whisper-1",
};

describe("assertModelId", () => {
  it("accepts Hub-style namespaced ids", () => {
    expect(assertModelId("openai/whisper-large-v3")).toBe("openai/whisper-large-v3");
  });

  it("accepts a bare name and an Ollama-style tag", () => {
    expect(assertModelId("whisper-1")).toBe("whisper-1");
    expect(assertModelId("whisper:latest")).toBe("whisper:latest");
  });

  it("rejects a model id that would escape the request path", () => {
    expect(() => assertModelId("../../admin")).toThrow(/invalid model id/);
    // A leading dot is not what makes this dangerous — an interior `..` walks
    // out of the /models prefix just as well, with the token still attached.
    expect(() => assertModelId("a/../../../v1/models")).toThrow(/path traversal/);
    expect(() => assertModelId("openai/whisper/../../admin")).toThrow(/path traversal/);
  });

  it("rejects ids outside the namespace/name shape", () => {
    expect(() => assertModelId("model?query=1")).toThrow(/invalid model id/);
    expect(() => assertModelId("too/many/segments")).toThrow(/invalid model id/);
    expect(() => assertModelId(`${"x".repeat(129)}`)).toThrow(/too long/);
  });

  it("reports a bad id as the user's to fix, not the backend's", () => {
    expect(() => assertModelId("nope!")).toThrow(SpeechValidationError);
  });
});

describe("OpenAICompatibleSpeech.transcribe", () => {
  it("uploads the audio to /audio/transcriptions and returns the text", async () => {
    const { calls, fetchImpl } = captureFetch(jsonResponse({ text: "  hello there  " }));
    const client = new OpenAICompatibleSpeech({
      baseUrl: `${BASE_URL}/`,
      secrets: { apiKey: "sk-test", headers: { "X-Extra": "1" } },
      fetchImpl,
      allowLoopback: true,
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
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });
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
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });
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
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });
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
    const client = new OpenAICompatibleSpeech({
      baseUrl: "http://10.0.0.5/v1",
      fetchImpl,
      allowLoopback: true,
    });
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
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });

    const result = await client.synthesize({ text: "hello", model: "kokoro", voice: "af_bella" });

    expect(result.contentType).toBe("audio/wav");
    expect(Array.from(result.audio)).toEqual([9, 9, 9]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9099/v1/audio/speech");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: "kokoro",
      input: "hello",
      voice: "af_bella",
      // WAV by default: mp3 needs an encoder the server may not have.
      response_format: "wav",
    });
  });

  it("sends a default voice when none is chosen", async () => {
    const { calls, fetchImpl } = captureFetch(new Response(new Uint8Array([1])));
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });
    await client.synthesize({ text: "hello", model: "kokoro" });
    expect(JSON.parse(calls[0]!.init.body as string).voice).toBe("alloy");
  });
});

/**
 * TTS servers have not converged: a cloning model takes a reference clip and
 * ignores `voice`, and several want body fields of their own.
 */
describe("OpenAICompatibleSpeech synthesis extras", () => {
  const client = (fetchImpl: typeof fetch) =>
    new OpenAICompatibleSpeech({ baseUrl: BASE_URL, fetchImpl, allowLoopback: true });

  it("passes a reference clip through as ref_audio", async () => {
    const { calls, fetchImpl } = captureFetch(new Response(new Uint8Array([1])));

    await client(fetchImpl).synthesize({
      text: "hello",
      model: "moss-tts-nano",
      refAudio: "data:audio/wav;base64,AAAA",
    });

    // MOSS-TTS-Nano refuses a request without it.
    expect(JSON.parse(calls[0]!.init.body as string).ref_audio).toBe("data:audio/wav;base64,AAAA");
  });

  it("omits ref_audio entirely when there is no clip", async () => {
    const { calls, fetchImpl } = captureFetch(new Response(new Uint8Array([1])));
    await client(fetchImpl).synthesize({ text: "hello", model: "kokoro" });
    expect("ref_audio" in JSON.parse(calls[0]!.init.body as string)).toBe(false);
  });

  it("merges extra fields and lets them override the defaults", async () => {
    const { calls, fetchImpl } = captureFetch(new Response(new Uint8Array([1])));

    await client(fetchImpl).synthesize({
      text: "hello",
      model: "moss-tts-nano",
      voice: "ignored-by-this-server",
      extras: { response_format: "wav", temperature: 0.7, stream: false },
    });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.response_format).toBe("wav");
    expect(body.temperature).toBe(0.7);
    expect(body.stream).toBe(false);
  });

  it("refuses to let extras rewrite the model or the text", async () => {
    const { calls, fetchImpl } = captureFetch(new Response(new Uint8Array([1])));

    await client(fetchImpl).synthesize({
      text: "the real text",
      model: "kokoro",
      extras: { model: "something-else", input: "not this" },
    });

    // Both are validated and length-capped before they get here; an override
    // would route around those checks.
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("kokoro");
    expect(body.input).toBe("the real text");
  });
});

describe("outbound guard", () => {
  it("refuses loopback unless the caller opted in", async () => {
    const { fetchImpl } = captureFetch(jsonResponse({ text: "x" }));
    const client = new OpenAICompatibleSpeech({ baseUrl: BASE_URL, fetchImpl });
    await expect(client.transcribe(transcribeArgs)).rejects.toThrow(/private address/);
  });

  it("re-checks the target of a redirect instead of following it blindly", async () => {
    // The guard would pass on the configured host and then be bypassed if the
    // redirect were followed by fetch itself.
    const { calls, fetchImpl } = scriptedFetch([
      redirectTo("http://169.254.169.254/latest/meta-data/"),
      jsonResponse({ text: "should never be reached" }),
    ]);
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });

    await expect(client.transcribe(transcribeArgs)).rejects.toThrow(/private address/);
    // Only the first hop was made; the second was refused before the request.
    expect(calls).toHaveLength(1);
  });

  it("does not let fetch follow redirects on its own", async () => {
    const { calls, fetchImpl } = scriptedFetch([jsonResponse({ text: "ok" })]);
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });
    await client.transcribe(transcribeArgs);
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("follows a redirect that stays within the allowed space", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      redirectTo("http://127.0.0.1:9099/v2/audio/transcriptions"),
      jsonResponse({ text: "moved" }),
    ]);
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });

    expect(await client.transcribe(transcribeArgs)).toBe("moved");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("http://127.0.0.1:9099/v2/audio/transcriptions");
  });

  it("gives up rather than following a redirect loop", async () => {
    const { fetchImpl } = scriptedFetch([redirectTo("http://127.0.0.1:9099/v1/loop")]);
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });
    await expect(client.transcribe(transcribeArgs)).rejects.toThrow(/too many redirects/);
  });

  it("passes an abort signal so a hung provider cannot stall the turn", async () => {
    const { calls, fetchImpl } = captureFetch(jsonResponse({ text: "ok" }));
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });
    await client.transcribe(transcribeArgs);
    expect(calls[0]!.init.signal).toBeDefined();
  });
});

describe("transcript bounds", () => {
  it("refuses a transcript past the cap rather than prompting with it", async () => {
    const { fetchImpl } = captureFetch(
      jsonResponse({ text: "a".repeat(MAX_TRANSCRIPT_CHARS + 1) }),
    );
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });
    await expect(client.transcribe(transcribeArgs)).rejects.toThrow(/exceeds/);
  });
});

/**
 * Hugging Face is the provider that ships available out of the box, so it is
 * covered here too. A public IP literal keeps the SSRF guard offline — literals
 * skip the DNS lookup — while the real request path still runs.
 */
describe("HuggingFaceSpeech", () => {
  const HF_BASE = "https://93.184.216.34/hf-inference";

  it("posts the raw audio to the model's ASR endpoint", async () => {
    const { calls, fetchImpl } = captureFetch(jsonResponse({ text: " hello " }));
    const client = new HuggingFaceSpeech("hf_token", `${HF_BASE}/`, fetchImpl);

    const text = await client.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      contentType: "audio/webm;codecs=opus",
      model: "openai/whisper-large-v3",
    });

    expect(text).toBe("hello");
    // A trailing slash on the base must not double up in the path.
    expect(calls[0]!.url).toBe("https://93.184.216.34/hf-inference/models/openai/whisper-large-v3");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer hf_token");
    expect(headers["Content-Type"]).toBe("audio/webm;codecs=opus");
  });

  it("sends TTS text as `inputs` and carries the response's audio type back", async () => {
    const { calls, fetchImpl } = captureFetch(
      new Response(new Uint8Array([7, 7]), {
        status: 200,
        headers: { "Content-Type": "audio/flac" },
      }),
    );
    const client = new HuggingFaceSpeech("hf_token", HF_BASE, fetchImpl);

    const result = await client.synthesize({ text: "hello", model: "hexgrad/Kokoro-82M" });

    expect(result.contentType).toBe("audio/flac");
    expect(Array.from(result.audio)).toEqual([7, 7]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ inputs: "hello" });
  });

  it("falls back to audio/mpeg when the provider declares no type", async () => {
    const { fetchImpl } = captureFetch(new Response(new Uint8Array([1])));
    const client = new HuggingFaceSpeech("hf_token", HF_BASE, fetchImpl);
    const result = await client.synthesize({ text: "hi", model: "hexgrad/Kokoro-82M" });
    expect(result.contentType).toBe("audio/mpeg");
  });

  it("surfaces a cold-model 503 so the user knows to retry", async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify({ error: "Model is loading", estimated_time: 20 }), {
        status: 503,
      }),
    );
    const client = new HuggingFaceSpeech("hf_token", HF_BASE, fetchImpl);
    await expect(
      client.transcribe({ ...transcribeArgs, model: "openai/whisper-large-v3" }),
    ).rejects.toThrow(/transcription failed \(503\).*Model is loading/);
  });

  it("refuses a traversal model id before making any request", async () => {
    const { calls, fetchImpl } = captureFetch(jsonResponse({ text: "x" }));
    const client = new HuggingFaceSpeech("hf_token", HF_BASE, fetchImpl);
    await expect(
      client.transcribe({ ...transcribeArgs, model: "a/../../../v1/models" }),
    ).rejects.toThrow(SpeechValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("empty synthesis responses", () => {
  it("refuses a 200 with no audio in it", async () => {
    // mlx-audio answers exactly this way when its model fails after the headers
    // are sent; the real reason only shows up in that server's own log.
    const { fetchImpl } = captureFetch(
      new Response(new Uint8Array(), { status: 200, headers: { "Content-Type": "audio/mp3" } }),
    );
    const client = new OpenAICompatibleSpeech({
      baseUrl: BASE_URL,
      fetchImpl,
      allowLoopback: true,
    });

    await expect(client.synthesize({ text: "hello", model: "kokoro" })).rejects.toThrow(
      /returned no audio/,
    );
  });

  it("applies the same check to Hugging Face", async () => {
    const { fetchImpl } = captureFetch(new Response(new Uint8Array(), { status: 200 }));
    const client = new HuggingFaceSpeech(
      "hf_token",
      "https://93.184.216.34/hf-inference",
      fetchImpl,
    );
    await expect(client.synthesize({ text: "hello", model: "some/model" })).rejects.toThrow(
      /returned no audio/,
    );
  });
});

/**
 * A public literal IP, like the Hugging Face tests use: the outbound guard
 * refuses loopback for a hosted provider, and an IP skips the DNS lookup, so
 * these stay offline while the real request path runs.
 */
const GEMINI_BASE_URL = "https://93.184.216.34/v1beta";

function geminiText(text: string): Response {
  return jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] });
}

function geminiAudio(data: string, mimeType: string): Response {
  return jsonResponse({
    candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }],
  });
}

/** Two samples of silence; enough to prove the header is written around them. */
const PCM_BYTES = new Uint8Array([0, 0, 1, 0]);

describe("pcmToWav", () => {
  it("writes a RIFF header describing 16-bit mono at the given rate", () => {
    const wav = pcmToWav(PCM_BYTES, 24_000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(PCM_BYTES.byteLength);
    expect(wav.slice(44)).toEqual(PCM_BYTES);
  });
});

describe("pcmSampleRate", () => {
  it("reads the rate parameter", () => {
    expect(pcmSampleRate("audio/L16;codec=pcm;rate=16000")).toBe(16_000);
  });

  it("falls back to Gemini's own rate when the type carries none", () => {
    expect(pcmSampleRate("audio/L16")).toBe(24_000);
  });
});

describe("GeminiSpeech.transcribe", () => {
  it("sends the clip as an inline part and returns the text", async () => {
    const { calls, fetchImpl } = captureFetch(geminiText("  hello there  "));
    const client = new GeminiSpeech("k", GEMINI_BASE_URL, fetchImpl);
    const text = await client.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      contentType: "audio/wav",
      model: "gemini-3.5-flash",
      language: "en",
    });

    expect(text).toBe("hello there");
    expect(calls[0]?.url).toBe(`${GEMINI_BASE_URL}/models/gemini-3.5-flash:generateContent`);
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      contents: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[];
    };
    const parts = body.contents[0]!.parts;
    expect(parts[0]?.text).toContain("en");
    expect(parts[1]?.inlineData?.mimeType).toBe("audio/wav");
    expect(parts[1]?.inlineData?.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("drops codec parameters, which Gemini matches on exactly", async () => {
    const { calls, fetchImpl } = captureFetch(geminiText("hi"));
    await new GeminiSpeech("k", GEMINI_BASE_URL, fetchImpl).transcribe({
      audio: new Uint8Array([1]),
      contentType: "audio/webm;codecs=opus",
      model: "gemini-3.5-flash",
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      contents: { parts: { inlineData?: { mimeType: string } }[] }[];
    };
    expect(body.contents[0]!.parts[1]?.inlineData?.mimeType).toBe("audio/webm");
  });

  it("reports a safety block as the user's to fix, not a bad gateway", async () => {
    const { fetchImpl } = captureFetch(jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(
      new GeminiSpeech("k", GEMINI_BASE_URL, fetchImpl).transcribe({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
        model: "gemini-3.5-flash",
      }),
    ).rejects.toThrow(/Gemini blocked the request: SAFETY/);
  });

  it("refuses a transcript past the cap", async () => {
    const { fetchImpl } = captureFetch(geminiText("x".repeat(MAX_TRANSCRIPT_CHARS + 1)));
    await expect(
      new GeminiSpeech("k", GEMINI_BASE_URL, fetchImpl).transcribe({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
        model: "gemini-3.5-flash",
      }),
    ).rejects.toThrow(/exceeds/);
  });
});

describe("GeminiSpeech.synthesize", () => {
  it("asks for the audio modality and wraps the PCM it gets back", async () => {
    const { calls, fetchImpl } = captureFetch(
      geminiAudio(Buffer.from(PCM_BYTES).toString("base64"), "audio/L16;codec=pcm;rate=24000"),
    );
    const { audio, contentType } = await new GeminiSpeech(
      "k",
      GEMINI_BASE_URL,
      fetchImpl,
    ).synthesize({ text: "hello", model: "gemini-2.5-flash-preview-tts", voice: "Puck" });

    expect(contentType).toBe("audio/wav");
    expect(audio.byteLength).toBe(44 + PCM_BYTES.byteLength);
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      generationConfig: {
        responseModalities: string[];
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
      };
    };
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      "Puck",
    );
  });

  it("passes extras through as generation config but keeps the audio modality", async () => {
    const { calls, fetchImpl } = captureFetch(
      geminiAudio(Buffer.from(PCM_BYTES).toString("base64"), "audio/L16;rate=24000"),
    );
    await new GeminiSpeech("k", GEMINI_BASE_URL, fetchImpl).synthesize({
      text: "hello",
      model: "gemini-2.5-flash-preview-tts",
      extras: { temperature: 0.4, responseModalities: "TEXT" },
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      generationConfig: { responseModalities: string[]; temperature: number };
    };
    expect(body.generationConfig.temperature).toBe(0.4);
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
  });

  it("leaves an already-containered format alone", async () => {
    const { fetchImpl } = captureFetch(
      geminiAudio(Buffer.from([1, 2, 3]).toString("base64"), "audio/mpeg"),
    );
    const { audio, contentType } = await new GeminiSpeech(
      "k",
      GEMINI_BASE_URL,
      fetchImpl,
    ).synthesize({ text: "hello", model: "gemini-2.5-flash-preview-tts" });
    expect(contentType).toBe("audio/mpeg");
    expect(audio.byteLength).toBe(3);
  });

  it("says which mistake was made when a chat model answers in text", async () => {
    const { fetchImpl } = captureFetch(geminiText("Sure! Here is what I would say."));
    await expect(
      new GeminiSpeech("k", GEMINI_BASE_URL, fetchImpl).synthesize({
        text: "hello",
        model: "gemini-3.5-flash",
      }),
    ).rejects.toThrow(/returned no audio/);
  });
});
