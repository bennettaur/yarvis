import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { availableVoiceProviders, resolveSpeechClient } from "./providers.ts";

// Custom providers (part of `resolveSpeechClient`'s lookup) now live in
// ~/.yarvis/settings.json — isolate each test from the real one.
let settingsDir: string;

beforeEach(async () => {
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-voice-providers-"));
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  await rm(settingsDir, { recursive: true, force: true });
});

function configWith(secrets: Partial<Config["secrets"]> = {}): Config {
  return {
    port: 0,
    token: "t",
    tokenGenerated: true,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl: undefined,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets,
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  };
}

describe("availableVoiceProviders", () => {
  it("marks Hugging Face unavailable without a token", async () => {
    const [huggingface] = await availableVoiceProviders(configWith());
    expect(huggingface?.id).toBe("huggingface");
    expect(huggingface?.available).toBe(false);
    // Suggestions are listed whether or not the key is set, so the UI can show
    // what the provider would offer.
    expect(huggingface?.sttModels.length).toBeGreaterThan(0);
  });

  it("suggests no Hugging Face speech models, because none are served", async () => {
    const [huggingface] = await availableVoiceProviders(configWith({ huggingFaceApiKey: "hf_x" }));
    // The obvious candidates all answer "Model not supported by provider
    // hf-inference". Suggesting one made a dead configuration look like the
    // default; transcription still works, speech out needs a local server.
    expect(huggingface?.ttsModels).toEqual([]);
  });

  it("marks Hugging Face available once a token is configured", async () => {
    const [huggingface] = await availableVoiceProviders(configWith({ huggingFaceApiKey: "hf_x" }));
    expect(huggingface?.available).toBe(true);
  });

  it("offers Gemini for both halves once its key is configured", async () => {
    const unkeyed = (await availableVoiceProviders(configWith())).find((p) => p.id === "gemini");
    expect(unkeyed?.available).toBe(false);

    const gemini = (await availableVoiceProviders(configWith({ geminiApiKey: "g" }))).find(
      (p) => p.id === "gemini",
    );
    expect(gemini?.available).toBe(true);
    expect(gemini?.capabilities.sort()).toEqual(["stt", "tts"]);
  });

  it("suggests Gemini's chat models for speech in and its TTS models for speech out", async () => {
    const gemini = (await availableVoiceProviders(configWith({ geminiApiKey: "g" }))).find(
      (p) => p.id === "gemini",
    );
    // The same endpoint transcribes, so the chat models are the STT suggestions
    // — and the TTS models, which cannot answer in text, appear only opposite.
    expect(gemini?.sttModels.length).toBeGreaterThan(0);
    expect(gemini?.ttsModels.every((m) => m.endsWith("-tts"))).toBe(true);
    expect(gemini?.sttModels.some((m) => gemini.ttsModels.includes(m))).toBe(false);
  });
});

describe("resolveSpeechClient", () => {
  it("refuses Hugging Face without a token", async () => {
    await expect(resolveSpeechClient(configWith(), "huggingface")).rejects.toThrow(
      /Hugging Face API key not configured/,
    );
  });

  it("resolves Hugging Face once a token is configured", async () => {
    const client = await resolveSpeechClient(
      configWith({ huggingFaceApiKey: "hf_x" }),
      "huggingface",
    );
    expect(typeof client.transcribe).toBe("function");
    expect(typeof client.synthesize).toBe("function");
  });

  it("refuses Gemini without a key and resolves it with one", async () => {
    await expect(resolveSpeechClient(configWith(), "gemini")).rejects.toThrow(
      /Gemini API key not configured/,
    );
    const client = await resolveSpeechClient(configWith({ geminiApiKey: "g" }), "gemini");
    expect(typeof client.transcribe).toBe("function");
    expect(typeof client.synthesize).toBe("function");
  });

  it("rejects an unknown provider id", async () => {
    await expect(resolveSpeechClient(configWith(), "nope")).rejects.toThrow(
      /unknown voice provider/,
    );
  });

  it("throws when the custom provider id is unknown", async () => {
    await expect(resolveSpeechClient(configWith(), "custom:abc")).rejects.toThrow(
      /unknown custom provider/,
    );
  });
});
