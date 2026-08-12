import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import { availableVoiceProviders, resolveSpeechClient } from "./providers.ts";

function configWith(secrets: Partial<Config["secrets"]> = {}): Config {
  return {
    port: 0,
    token: "t",
    tokenGenerated: true,
    attentionToken: "test-attention-token",
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
    expect(huggingface?.ttsModels.length).toBeGreaterThan(0);
  });

  it("marks Hugging Face available once a token is configured", async () => {
    const [huggingface] = await availableVoiceProviders(configWith({ huggingFaceApiKey: "hf_x" }));
    expect(huggingface?.available).toBe(true);
  });
});

describe("resolveSpeechClient", () => {
  it("refuses Hugging Face without a token", async () => {
    await expect(resolveSpeechClient(configWith(), undefined, "huggingface")).rejects.toThrow(
      /Hugging Face API key not configured/,
    );
  });

  it("resolves Hugging Face once a token is configured", async () => {
    const client = await resolveSpeechClient(
      configWith({ huggingFaceApiKey: "hf_x" }),
      undefined,
      "huggingface",
    );
    expect(typeof client.transcribe).toBe("function");
    expect(typeof client.synthesize).toBe("function");
  });

  it("rejects an unknown provider id", async () => {
    await expect(resolveSpeechClient(configWith(), undefined, "nope")).rejects.toThrow(
      /unknown voice provider/,
    );
  });

  it("needs a database before it can resolve a custom provider", async () => {
    await expect(resolveSpeechClient(configWith(), undefined, "custom:abc")).rejects.toThrow(
      /custom providers require a configured database/,
    );
  });
});
