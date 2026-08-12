import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { UrlSafetyError } from "../lib/urlSafety.ts";
import { availableVoiceProviders, resolveSpeechClient } from "./providers.ts";
import {
  MAX_AUDIO_BYTES,
  MAX_SPEECH_CHARS,
  RESERVED_SYNTHESIS_FIELDS,
  type SpeechClient,
  SpeechRequestRejected,
  SpeechValidationError,
} from "./speech.ts";

/**
 * Voice routes, mounted under /api/voice.
 *
 * The loop itself lives in the frontend — record, `POST /transcribe`, hand the
 * text to the existing chat stream, speak each finished sentence through
 * `POST /speak`. Keeping the two speech calls separate (rather than one
 * audio-in/audio-out endpoint) is what lets the reply start playing while the
 * model is still generating the rest of it.
 */

/** Audio container types a browser recorder produces, plus the common uploads. */
const AUDIO_CONTENT_TYPE =
  /^audio\/(webm|ogg|wav|x-wav|wave|mpeg|mp3|mp4|m4a|x-m4a|flac|aac)(;.*)?$/i;

/**
 * Reference clips are base64 inside JSON, so a few seconds of wav runs to
 * hundreds of kilobytes. This bounds the request without ruling out the ~10s
 * clip a cloning model actually wants.
 */
const MAX_REF_AUDIO_CHARS = 4 * 1024 * 1024;

/** `data:audio/<subtype>;base64,<payload>` and nothing else. */
const REF_AUDIO_DATA_URI = /^data:audio\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/;

const speakSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  text: z.string().min(1).max(MAX_SPEECH_CHARS),
  voice: z.string().max(128).optional(),
  refAudio: z
    .string()
    .max(MAX_REF_AUDIO_CHARS)
    .regex(REF_AUDIO_DATA_URI, "reference audio must be a base64 audio data URI")
    .optional(),
  /**
   * Server-specific body fields. Values stay scalar: a nested object would be
   * unbounded, and no TTS server here needs one.
   */
  extras: z
    .record(z.string().min(1).max(64), z.union([z.string().max(4096), z.number(), z.boolean()]))
    .refine(
      (fields) => !RESERVED_SYNTHESIS_FIELDS.some((key) => key in fields),
      `these fields are set from the request itself: ${RESERVED_SYNTHESIS_FIELDS.join(", ")}`,
    )
    .optional(),
});

const transcribeQuerySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  // ISO-639-1, optionally with a region ("en", "en-US").
  language: z
    .string()
    .regex(/^[a-z]{2}(-[A-Za-z]{2})?$/, "language must be an ISO-639-1 code")
    .optional(),
});

/**
 * Maps a failure onto a status the UI can act on. A rejected URL, a mistyped
 * model id, or a backend that refused the request outright is the user's to fix
 * (400); only a backend that failed to serve it is a 502. Model and format are
 * both free choices here, so getting this split right is the difference between
 * "fix what you sent" and "the provider is down".
 */
function speechErrorStatus(error: unknown): 400 | 502 {
  return error instanceof UrlSafetyError ||
    error instanceof SpeechValidationError ||
    error instanceof SpeechRequestRejected
    ? 400
    : 502;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Audio types the synthesis response may carry. A provider is user-configured
 * and may be a local process, so its declared content type is not echoed
 * verbatim onto a response served from the sidecar's own origin.
 */
const AUDIO_RESPONSE_TYPE = /^audio\/[A-Za-z0-9.+-]+(;.*)?$/;

function safeAudioType(contentType: string): string {
  return AUDIO_RESPONSE_TYPE.test(contentType) ? contentType : "audio/mpeg";
}

export function createVoiceRoutes(config: Config): Hono {
  const router = new Hono();

  const db = () => (config.databaseUrl ? getDb(config.databaseUrl).db : undefined);

  router.get("/providers", async (c) => c.json(await availableVoiceProviders(config, db())));

  /**
   * Transcribes one utterance. The audio rides as the raw request body rather
   * than a multipart upload: the browser already holds it as a single Blob, and
   * this keeps the hop that sits in the user's latency path free of encoding
   * work on both ends.
   */
  router.post("/transcribe", async (c) => {
    const parsed = transcribeQuerySchema.safeParse({
      provider: c.req.query("provider"),
      model: c.req.query("model"),
      language: c.req.query("language") || undefined,
    });
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const contentType = c.req.header("content-type") ?? "";
    if (!AUDIO_CONTENT_TYPE.test(contentType)) {
      return c.json({ error: `unsupported audio content type: ${contentType || "none"}` }, 415);
    }

    // Checked before the body is read, so the cap bounds what this process
    // buffers rather than only what it forwards.
    const declaredLength = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
      return c.json({ error: `audio exceeds ${MAX_AUDIO_BYTES} bytes` }, 413);
    }

    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.byteLength === 0) return c.json({ error: "empty audio" }, 400);
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      return c.json({ error: `audio exceeds ${MAX_AUDIO_BYTES} bytes` }, 413);
    }

    let client: SpeechClient;
    try {
      client = await resolveSpeechClient(config, db(), parsed.data.provider);
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }

    try {
      const text = await client.transcribe({
        audio,
        contentType,
        model: parsed.data.model,
        language: parsed.data.language,
      });
      return c.json({ text });
    } catch (e) {
      console.error("[voice] transcription failed:", e);
      return c.json({ error: errorMessage(e) }, speechErrorStatus(e));
    }
  });

  /** Synthesizes one chunk of the reply, answering with the provider's audio bytes. */
  router.post("/speak", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = speakSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    let client: SpeechClient;
    try {
      client = await resolveSpeechClient(config, db(), parsed.data.provider);
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }

    try {
      const { audio, contentType } = await client.synthesize({
        text: parsed.data.text,
        model: parsed.data.model,
        voice: parsed.data.voice,
        refAudio: parsed.data.refAudio,
        extras: parsed.data.extras,
      });
      return new Response(audio, {
        status: 200,
        headers: {
          "Content-Type": safeAudioType(contentType),
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (e) {
      console.error("[voice] synthesis failed:", e);
      return c.json({ error: errorMessage(e) }, speechErrorStatus(e));
    }
  });

  return router;
}
