import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { ProviderInfo } from "../../lib/chat";
import type { VoiceProviderInfo } from "../../lib/voice";
import { DEFAULT_VOICE_SETTINGS } from "../../lib/voiceSettings";
import { renderToHtml } from "../../test/render";
import VoiceSettingsBar from "./VoiceSettingsBar";

/**
 * Rendered from props alone — no sidecar stub — because a `mock.module` of
 * `../lib/api` leaks into every file that runs after this one (see
 * `src/test/nativeInvoke.ts`).
 */

const LLM_PROVIDERS: ProviderInfo[] = [
  { id: "cerebras", label: "Cerebras", models: ["zai-glm-4.6"], available: true },
  { id: "anthropic", label: "Anthropic", models: ["claude-opus-4-7"], available: false },
];

const VOICE_PROVIDERS: VoiceProviderInfo[] = [
  {
    id: "huggingface",
    label: "Hugging Face",
    available: true,
    sttModels: ["openai/whisper-large-v3-turbo"],
    ttsModels: ["hexgrad/Kokoro-82M"],
  },
  {
    id: "custom:local",
    label: "Local speech server",
    available: true,
    sttModels: [],
    ttsModels: [],
  },
];

const SETTINGS = {
  ...DEFAULT_VOICE_SETTINGS,
  llmProvider: "cerebras",
  llmModel: "zai-glm-4.6",
  sttProvider: "huggingface",
  sttModel: "openai/whisper-large-v3-turbo",
  ttsProvider: "huggingface",
  ttsModel: "hexgrad/Kokoro-82M",
};

function render(settings = SETTINGS) {
  return renderToHtml(
    createElement(VoiceSettingsBar, {
      settings,
      onChange: () => {},
      llmProviders: LLM_PROVIDERS,
      voiceProviders: VOICE_PROVIDERS,
    }),
  );
}

describe("VoiceSettingsBar", () => {
  it("picks the answering model and the two speech backends separately", async () => {
    const html = await render();
    expect(html).toContain("Answering model");
    expect(html).toContain("Speech to text");
    expect(html).toContain("Text to speech");
  });

  it("marks a provider with no key as unusable", async () => {
    const html = await render();
    expect(html).toContain("Anthropic (no key)");
  });

  it("lists every speech provider, including custom ones", async () => {
    const html = await render();
    expect(html).toContain("Hugging Face");
    expect(html).toContain("Local speech server");
  });

  it("suggests the provider's speech models without locking the field to them", async () => {
    const html = await render();
    expect(html).toContain("openai/whisper-large-v3-turbo");
    expect(html).toContain("hexgrad/Kokoro-82M");
    expect(html).toContain("<datalist");
  });

  it("shows the model a user typed even when the catalog doesn't list it", async () => {
    const html = await render({ ...SETTINGS, sttModel: "Systran/faster-whisper-large-v3" });
    expect(html).toContain("Systran/faster-whisper-large-v3");
  });
});
