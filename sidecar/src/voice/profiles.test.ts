import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { clipPath, wavSampleRate } from "./profiles.ts";

/**
 * Saved voices and the Voice Studio against a fake OpenAI-audio server, so the
 * clip handling is checked on what actually reaches the wire.
 */

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: undefined,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

/** A canonical 44-byte PCM WAV header followed by a little silence. */
function wav(sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + 32);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, 32, true);
  return bytes;
}

interface SeenSpeech {
  model: string;
  input: string;
  voice: string;
  ref_audio?: string;
}

function startSpeechServer() {
  const seen: SeenSpeech[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/audio/speech") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as SeenSpeech;
      seen.push(body);
      if (body.model === "broken/model") return new Response("nope", { status: 500 });
      return new Response(wav(24_000), { headers: { "Content-Type": "audio/wav" } });
    },
  });
  return { server, seen, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

async function registerProvider(baseUrl: string): Promise<string> {
  const res = await app.request("/api/custom-providers", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({
      name: "local speech",
      baseUrl,
      apiKind: "openai",
      models: [],
      headerNames: [],
    }),
  });
  const { id } = (await res.json()) as { id: string };
  return `custom:${id}`;
}

async function createVoice(body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await app.request("/api/voice/voices", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

function putClip(id: string, bytes: Uint8Array, contentType = "audio/wav") {
  return app.request(`/api/voice/voices/${id}/clip`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": contentType },
    body: bytes,
  });
}

let dir: string;
let originalSettings: string | undefined;
let originalDownloads: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-voice-profiles-"));
  originalSettings = process.env.YARVIS_SETTINGS_PATH;
  originalDownloads = process.env.YARVIS_DOWNLOADS_DIR;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
  process.env.YARVIS_DOWNLOADS_DIR = join(dir, "Downloads");
});

afterEach(async () => {
  if (originalSettings === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettings;
  if (originalDownloads === undefined) delete process.env.YARVIS_DOWNLOADS_DIR;
  else process.env.YARVIS_DOWNLOADS_DIR = originalDownloads;
  await rm(dir, { recursive: true, force: true });
});

describe("wavSampleRate", () => {
  it("reads the rate from a canonical header", () => {
    expect(wavSampleRate(wav(16_000))).toBe(16_000);
  });

  it("refuses bytes that are not a WAV file", () => {
    expect(() => wavSampleRate(new Uint8Array(64))).toThrow("must be a WAV file");
  });
});

describe("saved voices", () => {
  it("sends a path-mode clip as its location on disk", async () => {
    const { server, seen, baseUrl } = startSpeechServer();
    try {
      const provider = await registerProvider(baseUrl);
      const { id } = await createVoice({
        name: "Me",
        provider,
        model: "mlx-community/MOSS-TTS-Nano-100M",
      });
      expect((await putClip(id, wav(16_000))).status).toBe(200);

      const res = await app.request(`/api/voice/voices/${id}/speak`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(200);
      expect(seen[0]?.ref_audio).toBe(clipPath(id));
    } finally {
      server.stop(true);
    }
  });

  it("sends an inline-mode clip as a data URI", async () => {
    const { server, seen, baseUrl } = startSpeechServer();
    try {
      const provider = await registerProvider(baseUrl);
      const { id } = await createVoice({
        name: "Me",
        provider,
        model: "OpenMOSS-Team/MOSS-TTS-Nano",
        refAudioMode: "inline",
      });
      await putClip(id, wav(16_000));
      await app.request(`/api/voice/voices/${id}/speak`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ text: "hello" }),
      });
      expect(seen[0]?.ref_audio?.startsWith("data:audio/wav;base64,")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("refuses a 44.1 kHz clip, which cloning models ramble on", async () => {
    const { id } = await createVoice({ name: "Me", provider: "gemini", model: "x" });
    const res = await putClip(id, wav(44_100));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("44100 Hz");
  });

  it("refuses a clip that isn't sent as WAV", async () => {
    const { id } = await createVoice({ name: "Me", provider: "gemini", model: "x" });
    expect((await putClip(id, wav(16_000), "audio/webm")).status).toBe(415);
  });

  it("removes the clip and clears the active voice when the voice is deleted", async () => {
    const { id } = await createVoice({ name: "Me", provider: "gemini", model: "x" });
    await putClip(id, wav(16_000));
    await app.request("/api/voice/config", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ activeVoiceId: id }),
    });

    const res = await app.request(`/api/voice/voices/${id}`, { method: "DELETE", headers: auth });
    expect(res.status).toBe(204);
    expect(existsSync(clipPath(id))).toBe(false);
    const voiceConfig = (await (
      await app.request("/api/voice/config", { headers: auth })
    ).json()) as {
      activeVoiceId: string;
    };
    expect(voiceConfig.activeVoiceId).toBe("");
  });
});

describe("voice studio", () => {
  it("speaks the text in each voice, reports a failing one, and clears the last batch", async () => {
    const { server, baseUrl } = startSpeechServer();
    try {
      const provider = await registerProvider(baseUrl);
      const good = await createVoice({ name: "Narrator", provider, model: "good/model" });
      const bad = await createVoice({ name: "Broken", provider, model: "broken/model" });

      const generate = async () => {
        const res = await app.request("/api/voice/studio/generate", {
          method: "POST",
          headers: jsonAuth,
          body: JSON.stringify({ text: "Hello there", voiceIds: [good.id, bad.id] }),
        });
        expect(res.status).toBe(200);
        return (await res.json()) as {
          takes: { file: string; voiceName: string }[];
          failures: { voiceName: string }[];
        };
      };

      const first = await generate();
      expect(first.takes.map((t) => t.voiceName)).toEqual(["Narrator"]);
      expect(first.failures.map((f) => f.voiceName)).toEqual(["Broken"]);
      const firstFile = first.takes[0]?.file ?? "";

      const saved = await app.request(`/api/voice/studio/takes/${firstFile}/save`, {
        method: "POST",
        headers: auth,
      });
      const { savedPath } = (await saved.json()) as { savedPath: string };
      expect(savedPath).toBe(join(dir, "Downloads", "Yarvis Voice", firstFile));

      await generate();
      const stale = await app.request(`/api/voice/studio/takes/${firstFile}`, { headers: auth });
      expect(stale.status).toBe(404);
      expect(existsSync(savedPath)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("refuses a take name outside the studio's own pattern", async () => {
    const res = await app.request("/api/voice/studio/takes/..%2Fsettings.json", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("asks for a translation model before translating", async () => {
    const res = await app.request("/api/voice/studio/generate", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ text: "Hello", voiceIds: ["default"], language: "French" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("translation model");
  });
});
