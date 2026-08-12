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

/**
 * Longest transcript accepted from a provider. Every other side of this
 * exchange is bounded (audio in, speech text out, the chat route's `context`),
 * so without this a misbehaving backend could return megabytes of text that go
 * straight into a prompt and get persisted as a chat message.
 */
export const MAX_TRANSCRIPT_CHARS = 8000;

/** Deadline for one transcription; generous because a cold hosted model is slow. */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/**
 * Deadline for one synthesis call. Tighter than transcription: chunks are at
 * most `MAX_SPEECH_CHARS`, and a stalled call here holds up the whole spoken
 * reply behind it.
 */
const SYNTHESIZE_TIMEOUT_MS = 30_000;

/** Redirect hops followed before giving up, matching `memory/ingest.ts`. */
const MAX_REDIRECTS = 5;

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
 * A request the user can fix by changing what they typed, as opposed to a
 * backend failure. The routes map this to 400 and everything else to 502, so a
 * mistyped model id doesn't get reported as a bad gateway.
 */
export class SpeechValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechValidationError";
  }
}

/**
 * One path segment of a model id: Hub `namespace/name`, optionally with an
 * Ollama-style `:tag`. Model ids are typed by the user and land in a request
 * path (Hugging Face), so the shape is enumerated rather than the charset
 * merely filtered — a charset alone still admits `a/../../v1/models`, which
 * would leave the intended path prefix with the credential attached.
 */
const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";
const MODEL_ID = new RegExp(`^${SEGMENT}(/${SEGMENT})?(:${SEGMENT})?$`);

/** Longest model id accepted; well past any real Hub or local-server name. */
const MAX_MODEL_ID_CHARS = 128;

export function assertModelId(model: string): string {
  const invalid = (why: string) => new SpeechValidationError(`invalid model id: ${why}`);
  if (model.length > MAX_MODEL_ID_CHARS) throw invalid("too long");
  // `..` is legal in the charset above (`a..b`) but never legal in a real name,
  // and it is the one sequence that changes what a path means.
  if (model.includes("..")) throw invalid("path traversal");
  if (!MODEL_ID.test(model)) throw invalid(model);
  return model;
}

/** Default Hugging Face Inference router; the `hf-inference` provider serves ASR/TTS. */
const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/hf-inference";

/**
 * Bounds an error body before it reaches a log line or the client. Redaction
 * runs before the truncation: a token straddling the cut would otherwise lose
 * the tail the redaction patterns match on, and the surviving prefix would be
 * emitted verbatim.
 */
function errorDetail(body: string): string {
  return redactSecrets(body.trim()).slice(0, 300);
}

async function throwSpeechError(what: string, res: Response): Promise<never> {
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
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error(`transcript exceeds ${MAX_TRANSCRIPT_CHARS} characters`);
  }
  return text.trim();
}

interface GuardedFetchOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  allowLoopback: boolean;
}

/**
 * Fetches with the SSRF guard applied to every hop, not just the first.
 *
 * `redirect: "manual"` is what makes that possible: under the default
 * `"follow"`, a 302 from the configured host to a private address is followed
 * before anything can re-check it, and `fetch` strips only `Authorization` on a
 * cross-origin redirect — a custom provider's own auth headers would ride
 * along to wherever the redirect pointed. The deadline covers the whole chain,
 * since these calls sit directly in the user's latency path.
 */
async function guardedFetch(
  url: string,
  init: RequestInit,
  { fetchImpl, timeoutMs, allowLoopback }: GuardedFetchOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await assertResolvableOutbound(url, { allowLoopback });
    let current = url;
    let res = await fetchImpl(current, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    let hops = 0;
    while (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      if (hops++ >= MAX_REDIRECTS) throw new Error("too many redirects");
      current = new URL(location, current).toString();
      await assertResolvableOutbound(current, { allowLoopback });
      res = await fetchImpl(current, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
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

  private modelUrl(model: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/models/${assertModelId(model)}`;
  }

  async transcribe({ audio, contentType, model }: TranscribeInput): Promise<string> {
    const res = await guardedFetch(
      this.modelUrl(model),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": contentType,
          Accept: "application/json",
        },
        body: audio,
      },
      { fetchImpl: this.fetchImpl, timeoutMs: TRANSCRIBE_TIMEOUT_MS, allowLoopback: false },
    );
    if (!res.ok) await throwSpeechError("transcription", res);
    return readTranscript(await res.json());
  }

  async synthesize({ text, model }: SynthesizeInput): Promise<SpeechAudio> {
    const res = await guardedFetch(
      this.modelUrl(model),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: text }),
      },
      { fetchImpl: this.fetchImpl, timeoutMs: SYNTHESIZE_TIMEOUT_MS, allowLoopback: false },
    );
    if (!res.ok) await throwSpeechError("speech synthesis", res);
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
  /**
   * Permit a loopback destination. Defaults to refusing one so a future caller
   * has to opt in deliberately; `resolveSpeechClient` passes it for
   * user-configured local servers, which are the legitimate case.
   */
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
    this.allowLoopback = options.allowLoopback ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...this.secrets.headers, ...extra };
    if (this.secrets.apiKey) headers.Authorization = `Bearer ${this.secrets.apiKey}`;
    return headers;
  }

  private fetchOptions(timeoutMs: number): GuardedFetchOptions {
    return { fetchImpl: this.fetchImpl, timeoutMs, allowLoopback: this.allowLoopback };
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

    const res = await guardedFetch(
      `${this.baseUrl}/audio/transcriptions`,
      {
        method: "POST",
        // Content-Type is left to FormData so it carries the multipart boundary.
        headers: this.headers(),
        body: form,
      },
      this.fetchOptions(TRANSCRIBE_TIMEOUT_MS),
    );
    if (!res.ok) await throwSpeechError("transcription", res);
    return readTranscript(await res.json());
  }

  async synthesize({ text, model, voice }: SynthesizeInput): Promise<SpeechAudio> {
    const res = await guardedFetch(
      `${this.baseUrl}/audio/speech`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          model: assertModelId(model),
          input: text,
          // Servers that ignore voices still require the field to be present.
          voice: voice || "alloy",
          response_format: "mp3",
        }),
      },
      this.fetchOptions(SYNTHESIZE_TIMEOUT_MS),
    );
    if (!res.ok) await throwSpeechError("speech synthesis", res);
    return {
      audio: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "audio/mpeg",
    };
  }
}
