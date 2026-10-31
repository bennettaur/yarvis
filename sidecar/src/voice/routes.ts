import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Config } from "../config.ts";
import { UrlSafetyError } from "../lib/urlSafety.ts";
import { getVoiceConfig, saveVoiceConfig } from "./config.ts";
import {
  createVoiceProfile,
  deleteVoiceClip,
  deleteVoiceProfile,
  getVoiceProfile,
  listVoiceProfiles,
  MAX_CLIP_BYTES,
  saveVoiceClip,
  speakWithProfile,
  updateVoiceProfile,
} from "./profiles.ts";
import { availableVoiceProviders, resolveSpeechClient } from "./providers.ts";
import { LocalSpeechServer, saveSpeechServerSettings } from "./server.ts";
import {
  MAX_AUDIO_BYTES,
  MAX_SPEECH_CHARS,
  RESERVED_SYNTHESIS_FIELDS,
  type SpeechClient,
  SpeechRequestRejected,
  SpeechValidationError,
} from "./speech.ts";
import {
  generateTakes,
  LANGUAGE,
  listTakes,
  readTake,
  type StudioDeps,
  saveTake,
} from "./studio.ts";

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

const refAudioSchema = z
  .string()
  .max(MAX_REF_AUDIO_CHARS)
  .regex(REF_AUDIO_DATA_URI, "reference audio must be a base64 audio data URI");

/**
 * Server-specific body fields. Values stay scalar: a nested object would be
 * unbounded, and no TTS server here needs one.
 */
const extrasSchema = z
  .record(z.string().min(1).max(64), z.union([z.string().max(4096), z.number(), z.boolean()]))
  .refine(
    (fields) => !RESERVED_SYNTHESIS_FIELDS.some((key) => key in fields),
    `these fields are set from the request itself: ${RESERVED_SYNTHESIS_FIELDS.join(", ")}`,
  );

const speakSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  text: z.string().min(1).max(MAX_SPEECH_CHARS),
  voice: z.string().max(128).optional(),
  refAudio: refAudioSchema.optional(),
  extras: extrasSchema.optional(),
});

/**
 * Every field is optional so the settings UI can save one at a time. Blank is
 * meaningful — it clears a selection — so absent and empty differ here.
 */
const voiceConfigSchema = z.object({
  sttProvider: z.string().max(128).optional(),
  sttModel: z.string().max(128).optional(),
  sttLanguage: z
    .string()
    .regex(/^([a-z]{2}(-[A-Za-z]{2})?)?$/, "language must be an ISO-639-1 code, or blank")
    .optional(),
  ttsProvider: z.string().max(128).optional(),
  ttsModel: z.string().max(128).optional(),
  ttsVoice: z.string().max(128).optional(),
  // Blank clears the stored clip, so the data-URI shape is only enforced when
  // there is something there.
  ttsRefAudio: z.union([refAudioSchema, z.literal("")]).optional(),
  ttsExtras: extrasSchema.optional(),
  speakReplies: z.boolean().optional(),
  handsFree: z.boolean().optional(),
  activeVoiceId: z.string().max(64).optional(),
  translationProvider: z.string().max(128).optional(),
  translationModel: z.string().max(128).optional(),
});

const voiceProfileFields = z.object({
  name: z.string().trim().min(1).max(64),
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(128),
  voice: z.string().max(128),
  refAudioMode: z.enum(["path", "inline"]),
  extras: extrasSchema,
});

const voiceProfileSchema = voiceProfileFields.extend({
  voice: voiceProfileFields.shape.voice.default(""),
  refAudioMode: voiceProfileFields.shape.refAudioMode.default("path"),
  extras: extrasSchema.default({}),
});

// No defaults here: a rename must not reset the fields it didn't send.
const voiceProfilePatchSchema = voiceProfileFields.partial();

const voiceSpeakSchema = z.object({ text: z.string().min(1).max(MAX_SPEECH_CHARS) });

const studioSchema = z.object({
  text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
  voiceIds: z.array(z.string().min(1).max(64)).min(1).max(12),
  language: z
    .union([
      z.string().regex(LANGUAGE, "language must be a name like French or pt-BR"),
      z.literal(""),
    ])
    .optional(),
});

const serverSettingsSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
});

const downloadSchema = z.object({ model: z.string().min(1).max(128) });

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

function audioResponse(audio: Uint8Array, contentType: string): Response {
  return new Response(audio, {
    status: 200,
    headers: {
      "Content-Type": safeAudioType(contentType),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The machine's one speech server, shared by every request this sidecar serves. */
const sharedSpeechServer = new LocalSpeechServer();

export interface VoiceRouteOptions {
  server?: LocalSpeechServer;
  studio?: StudioDeps;
}

export function createVoiceRoutes(config: Config, options: VoiceRouteOptions = {}): Hono {
  const router = new Hono();
  const server = options.server ?? sharedSpeechServer;

  router.get("/providers", async (c) => c.json(await availableVoiceProviders(config)));

  /** The speech settings, shared by every surface. Read directly from settings.json. */
  router.get("/config", async (c) => c.json(await getVoiceConfig()));

  router.patch("/config", async (c) => {
    const parsed = voiceConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveVoiceConfig(parsed.data));
  });

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
      client = await resolveSpeechClient(config, parsed.data.provider);
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
      client = await resolveSpeechClient(config, parsed.data.provider);
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
      return audioResponse(audio, contentType);
    } catch (e) {
      console.error("[voice] synthesis failed:", e);
      return c.json({ error: errorMessage(e) }, speechErrorStatus(e));
    }
  });

  router.get("/voices", async (c) => c.json(await listVoiceProfiles()));

  router.post("/voices", async (c) => {
    const parsed = voiceProfileSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await createVoiceProfile(parsed.data), 201);
  });

  router.patch("/voices/:id", async (c) => {
    const parsed = voiceProfilePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const row = await updateVoiceProfile(c.req.param("id"), parsed.data);
    return row ? c.json(row) : c.json({ error: "voice not found" }, 404);
  });

  router.delete("/voices/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await deleteVoiceProfile(id))) return c.json({ error: "voice not found" }, 404);
    // Replies would otherwise go silent pointing at a voice that no longer exists.
    if ((await getVoiceConfig()).activeVoiceId === id) await saveVoiceConfig({ activeVoiceId: "" });
    return c.body(null, 204);
  });

  /**
   * Stores a cloning clip. The body is the WAV itself: the app converts both a
   * recording and an upload to 16 kHz mono WAV first, which is the rate
   * cloning models handle best.
   */
  router.put(
    "/voices/:id/clip",
    bodyLimit({
      maxSize: MAX_CLIP_BYTES,
      onError: (c) => c.json({ error: `the clip exceeds ${MAX_CLIP_BYTES} bytes` }, 413),
    }),
    async (c) => {
      const contentType = c.req.header("content-type") ?? "";
      if (!/^audio\/(wav|x-wav|wave)$/i.test(contentType)) {
        return c.json({ error: "the clip must be sent as audio/wav" }, 415);
      }
      try {
        const row = await saveVoiceClip(
          c.req.param("id"),
          new Uint8Array(await c.req.arrayBuffer()),
        );
        return row ? c.json(row) : c.json({ error: "voice not found" }, 404);
      } catch (e) {
        return c.json({ error: errorMessage(e) }, 400);
      }
    },
  );

  router.delete("/voices/:id/clip", async (c) => {
    const row = await deleteVoiceClip(c.req.param("id"));
    return row ? c.json(row) : c.json({ error: "voice not found" }, 404);
  });

  /** Speaks in a saved voice. The clip is read here, so it never travels through the webview. */
  router.post("/voices/:id/speak", async (c) => {
    const parsed = voiceSpeakSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const profile = await getVoiceProfile(c.req.param("id"));
    if (!profile) return c.json({ error: "voice not found" }, 404);
    try {
      const { audio, contentType } = await speakWithProfile(config, profile, parsed.data.text);
      return audioResponse(audio, contentType);
    } catch (e) {
      console.error("[voice] synthesis failed:", e);
      return c.json({ error: errorMessage(e) }, speechErrorStatus(e));
    }
  });

  router.get("/studio/takes", async (c) => c.json(await listTakes()));

  router.post("/studio/generate", async (c) => {
    const parsed = studioSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(
        await generateTakes(
          config,
          {
            text: parsed.data.text,
            voiceIds: parsed.data.voiceIds,
            language: parsed.data.language || undefined,
          },
          options.studio,
        ),
      );
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }
  });

  router.get("/studio/takes/:file", async (c) => {
    const found = await readTake(c.req.param("file"));
    if (!found) return c.json({ error: "take not found" }, 404);
    return audioResponse(found.audio, found.take.contentType);
  });

  router.post("/studio/takes/:file/save", async (c) => {
    const take = await saveTake(c.req.param("file"));
    return take ? c.json(take) : c.json({ error: "take not found" }, 404);
  });

  router.get("/server", async (c) => c.json(await server.status()));

  router.patch("/server", async (c) => {
    const parsed = serverSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    await saveSpeechServerSettings(parsed.data);
    return c.json(await server.status());
  });

  router.post("/server/start", async (c) => c.json(await server.start()));

  router.post("/server/stop", async (c) => c.json(await server.stop()));

  router.get("/server/models", (c) => c.json(server.models()));

  router.post("/server/models/download", async (c) => {
    const parsed = downloadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(server.download(parsed.data.model), 202);
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }
  });

  /** Registers the server as a speech provider, so the pickers can offer its models. */
  router.post("/server/provider", async (c) =>
    c.json({ providerId: await server.ensureProvider() }),
  );

  return router;
}
