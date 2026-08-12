import type { CustomProviderSecrets } from "../config.ts";
import { assertResolvableOutbound } from "../lib/urlSafety.ts";
import { redactSecrets } from "../llm/errors.ts";

/**
 * Speech-to-text and text-to-speech over HTTP.
 *
 * Two wire protocols cover every backend the voice loop targets: Hugging Face
 * Inference (hosted Whisper/TTS models) and the OpenAI audio API
 * (`/audio/transcriptions`, `/audio/speech`), which local servers — a
 * whisper.cpp or Kokoro/MOSS-TTS wrapper on loopback — and gateways all speak.
 * Callers pick one through `voice/providers.ts` and never construct these
 * directly.
 */

/** Largest utterance accepted, matching the Hugging Face Inference API's cap. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Longest text synthesized in one call; the caller speaks longer replies in chunks. */
export const MAX_SPEECH_CHARS = 2000;

export interface TranscribeInput {
  audio: Uint8Array;
  /** MIME type of `audio`, as recorded by the browser (e.g. `audio/webm`). */
  contentType: string;
  model: string;
  /** ISO-639-1 hint; providers that can't use it ignore it. */
  language?: string;
}

export interface SynthesizeInput {
  text: string;
  model: string;
  /** Provider-specific voice id. Meaningless to Hugging Face's TTS models. */
  voice?: string;
}

export interface SpeechAudio {
  audio: Uint8Array;
  contentType: string;
}

export interface SpeechClient {
  transcribe(input: TranscribeInput): Promise<string>;
  synthesize(input: SynthesizeInput): Promise<SpeechAudio>;
}

/**
 * Charset a model id may use. Model ids are typed by the user and land in a
 * request path (Hugging Face) or body, so anything outside the Hub's own
 * `namespace/name` charset is refused rather than escaped — an escaped slash
 * would break the legitimate case anyway.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function assertModelId(model: string): string {
  if (!MODEL_ID.test(model)) throw new Error(`invalid model id: ${model}`);
  return model;
}

/** Default Hugging Face Inference router; the `hf-inference` provider serves ASR/TTS. */
export const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/hf-inference";

/** Bounds an error body before it reaches a log line or the client. */
function errorDetail(body: string): string {
  return redactSecrets(body.trim().slice(0, 300));
}

async function failed(what: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => "");
  const detail = errorDetail(body);
  throw new Error(
    detail ? `${what} failed (${res.status}): ${detail}` : `${what} failed (${res.status})`,
  );
}

/** Response shape shared by every ASR endpoint here: `{ text }`, or a list of them. */
function readTranscript(payload: unknown): string {
  const first = Array.isArray(payload) ? payload[0] : payload;
  const text = (first as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw new Error("transcription response had no text");
  return text.trim();
}

/**
 * Hugging Face Inference. ASR takes the raw audio bytes as the request body and
 * answers `{ text }`; TTS takes `{ inputs }` and answers audio bytes. A cold
 * model replies 503 with an `estimated_time` — surfaced as-is so the user knows
 * to retry rather than reading it as a broken configuration.
 */
export class HuggingFaceSpeech implements SpeechClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = HUGGINGFACE_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async modelUrl(model: string): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/models/${assertModelId(model)}`;
    await assertResolvableOutbound(url);
    return url;
  }

  async transcribe({ audio, contentType, model }: TranscribeInput): Promise<string> {
    const res = await this.fetchImpl(await this.modelUrl(model), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": contentType,
        Accept: "application/json",
      },
      body: audio,
    });
    if (!res.ok) await failed("transcription", res);
    return readTranscript(await res.json());
  }

  async synthesize({ text, model }: SynthesizeInput): Promise<SpeechAudio> {
    const res = await this.fetchImpl(await this.modelUrl(model), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: text }),
    });
    if (!res.ok) await failed("speech synthesis", res);
    return {
      audio: new Uint8Array(await res.arrayBuffer()),
      // Which audio format comes back depends on the model (flac, wav, mp3),
      // so the response's own content type is the only reliable source.
      contentType: res.headers.get("content-type") ?? "audio/mpeg",
    };
  }
}

export interface OpenAISpeechOptions {
  baseUrl: string;
  secrets?: CustomProviderSecrets;
  /** Loopback is legitimate here: these are user-configured local servers. */
  allowLoopback?: boolean;
  fetchImpl?: typeof fetch;
}

/** Filename extension guess for the multipart upload, which OpenAI servers sniff. */
function audioExtension(contentType: string): string {
  const subtype = contentType.split(";")[0]?.split("/")[1] ?? "";
  if (subtype.startsWith("x-")) return subtype.slice(2);
  return subtype || "webm";
}

/**
 * The OpenAI audio API, as served by a local speech server or a gateway. The
 * base URL is the same one the provider's chat models use (`.../v1`), so a
 * single custom-provider entry can back both chat and voice.
 */
export class OpenAICompatibleSpeech implements SpeechClient {
  private readonly baseUrl: string;
  private readonly secrets: CustomProviderSecrets;
  private readonly allowLoopback: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAISpeechOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.secrets = options.secrets ?? { headers: {} };
    this.allowLoopback = options.allowLoopback ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...this.secrets.headers, ...extra };
    if (this.secrets.apiKey) headers.Authorization = `Bearer ${this.secrets.apiKey}`;
    return headers;
  }

  private async endpoint(path: string): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    await assertResolvableOutbound(url, { allowLoopback: this.allowLoopback });
    return url;
  }

  async transcribe({ audio, contentType, model, language }: TranscribeInput): Promise<string> {
    const form = new FormData();
    form.set(
      "file",
      new Blob([audio], { type: contentType }),
      `speech.${audioExtension(contentType)}`,
    );
    form.set("model", assertModelId(model));
    form.set("response_format", "json");
    if (language) form.set("language", language);

    const res = await this.fetchImpl(await this.endpoint("/audio/transcriptions"), {
      method: "POST",
      // Content-Type is left to FormData so it carries the multipart boundary.
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) await failed("transcription", res);
    return readTranscript(await res.json());
  }

  async synthesize({ text, model, voice }: SynthesizeInput): Promise<SpeechAudio> {
    const res = await this.fetchImpl(await this.endpoint("/audio/speech"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: assertModelId(model),
        input: text,
        // Servers that ignore voices still require the field to be present.
        voice: voice || "alloy",
        response_format: "mp3",
      }),
    });
    if (!res.ok) await failed("speech synthesis", res);
    return {
      audio: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "audio/mpeg",
    };
  }
}
