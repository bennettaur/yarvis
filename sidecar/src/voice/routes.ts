import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { UrlSafetyError } from "../lib/urlSafety.ts";
import { availableVoiceProviders, resolveSpeechClient } from "./providers.ts";
import { MAX_AUDIO_BYTES, MAX_SPEECH_CHARS } from "./speech.ts";

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

const speakSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  text: z.string().min(1).max(MAX_SPEECH_CHARS),
  voice: z.string().max(128).optional(),
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

/** Maps a provider/backend failure onto a status the UI can act on. */
function speechErrorStatus(error: unknown): 400 | 502 {
  return error instanceof UrlSafetyError ? 400 : 502;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.byteLength === 0) return c.json({ error: "empty audio" }, 400);
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      return c.json({ error: `audio exceeds ${MAX_AUDIO_BYTES} bytes` }, 413);
    }

    let client: Awaited<ReturnType<typeof resolveSpeechClient>>;
    try {
      client = await resolveSpeechClient(config, db(), parsed.data.provider);
    } catch (e) {
      return c.json({ error: message(e) }, 400);
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
      return c.json({ error: message(e) }, speechErrorStatus(e));
    }
  });

  /** Synthesizes one chunk of the reply, answering with the provider's audio bytes. */
  router.post("/speak", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = speakSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    let client: Awaited<ReturnType<typeof resolveSpeechClient>>;
    try {
      client = await resolveSpeechClient(config, db(), parsed.data.provider);
    } catch (e) {
      return c.json({ error: message(e) }, 400);
    }

    try {
      const { audio, contentType } = await client.synthesize({
        text: parsed.data.text,
        model: parsed.data.model,
        voice: parsed.data.voice,
      });
      return new Response(audio, { status: 200, headers: { "Content-Type": contentType } });
    } catch (e) {
      console.error("[voice] synthesis failed:", e);
      return c.json({ error: message(e) }, speechErrorStatus(e));
    }
  });

  return router;
}
