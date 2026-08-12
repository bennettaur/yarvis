import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { ProviderInfo } from "../../lib/chat";
import type { VoiceProviderInfo } from "../../lib/voice";
import * as voiceApi from "../../lib/voice";
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "../../lib/voiceSettings";
import { mountForInteraction, renderToHtml } from "../../test/render";

/**
 * `speak` and audio playback are stubbed by spreading their real modules and
 * replacing one export each — a wholesale stub would strip the rest for every
 * file that runs after this one.
 */
let speakBehavior: () => Blob = () => new Blob(["audio"]);
let spokenText = "";

mock.module("../../lib/voice", () => ({
  ...voiceApi,
  speak: async (request: { text: string }) => {
    spokenText = request.text;
    return speakBehavior();
  },
}));

mock.module("../../lib/audioPlayback", () => ({
  playAudioBlob: async () => {},
}));

const { default: VoiceSettingsBar } = await import("./VoiceSettingsBar");

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
    capabilities: ["stt"],
    sttModels: ["openai/whisper-large-v3-turbo"],
    ttsModels: ["hexgrad/Kokoro-82M"],
  },
  {
    id: "custom:local",
    label: "Local speech server",
    available: true,
    capabilities: ["stt", "tts"],
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

  it("offers a language hint that defaults to auto-detect", async () => {
    const html = await render();
    expect(html).toContain("Spoken language");
    expect(html).toContain('placeholder="auto-detect"');
  });
});

/**
 * The bar's only real logic is what a provider change does to the model beside
 * it, so that is driven here rather than asserted from static markup.
 */
describe("VoiceSettingsBar interaction", () => {
  let unmount: (() => void) | null = null;

  afterEach(() => {
    unmount?.();
    unmount = null;
    speakBehavior = () => new Blob(["audio"]);
    spokenText = "";
  });

  const testButton = (host: HTMLElement) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Test")) as
      | HTMLButtonElement
      | undefined;

  async function mountBar(settings = SETTINGS) {
    const changes: VoiceSettings[] = [];
    const mounted = await mountForInteraction(
      createElement(VoiceSettingsBar, {
        settings,
        onChange: (next: VoiceSettings) => changes.push(next),
        llmProviders: LLM_PROVIDERS,
        voiceProviders: VOICE_PROVIDERS,
      }),
    );
    unmount = mounted.unmount;
    return { changes, host: mounted.host };
  }

  /** Picks a `<select>` by the label text above it and fires a change. */
  function selectByLabel(host: HTMLElement, label: string, value: string): void {
    const field = Array.from(host.querySelectorAll("label")).find((l) =>
      l.textContent?.startsWith(label),
    );
    const select = field?.querySelector("select");
    if (!select) throw new Error(`no select under "${label}"`);
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("moves the model to the new provider's first suggestion", async () => {
    const { changes, host } = await mountBar();

    selectByLabel(host, "Speech to text", "custom:local");

    expect(changes).toHaveLength(1);
    expect(changes[0]?.sttProvider).toBe("custom:local");
    // The old model belonged to Hugging Face and means nothing here; this
    // provider suggests nothing, so the field is cleared for the user to type.
    expect(changes[0]?.sttModel).toBe("");
  });

  it("keeps the two speech halves independent", async () => {
    const { changes, host } = await mountBar();

    selectByLabel(host, "Text to speech", "custom:local");

    expect(changes[0]?.ttsProvider).toBe("custom:local");
    // Changing who speaks must not change who listens.
    expect(changes[0]?.sttProvider).toBe("huggingface");
    expect(changes[0]?.sttModel).toBe("openai/whisper-large-v3-turbo");
  });

  it("switches the answering model without touching speech at all", async () => {
    const { changes, host } = await mountBar();

    selectByLabel(host, "Answering model", "anthropic");

    expect(changes[0]?.llmProvider).toBe("anthropic");
    expect(changes[0]?.llmModel).toBe("claude-opus-4-7");
    expect(changes[0]?.sttProvider).toBe("huggingface");
    expect(changes[0]?.ttsProvider).toBe("huggingface");
  });

  /**
   * The test button exists because a wrong model, a missing key and a cold
   * server are indistinguishable from the tab otherwise — all three are just
   * silence followed by a failed turn.
   */
  it("reports a failed test rather than leaving it silent", async () => {
    speakBehavior = () => {
      throw new Error("speak failed (400): Model not supported by provider hf-inference");
    };
    const { host } = await mountBar();

    testButton(host)?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(host.innerHTML).toContain("Model not supported by provider");
  });

  it("confirms a working configuration", async () => {
    speakBehavior = () => new Blob(["audio"]);
    const { host } = await mountBar();

    testButton(host)?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(host.innerHTML).toContain("Played the test phrase");
    expect(spokenText).toContain("Voice output is working");
  });

  it("refuses to test before a TTS model is chosen", async () => {
    const { host } = await mountBar({ ...SETTINGS, ttsModel: "" });
    expect(testButton(host)?.disabled).toBe(true);
  });
});

describe("VoiceSettingsBar capability filtering", () => {
  it("does not offer a transcription-only provider under Text to speech", async () => {
    const html = await render();
    const ttsSection = html.slice(html.indexOf("Text to speech"));
    // Hugging Face can transcribe but its router refuses every TTS model;
    // offering it here is offering a choice that fails on every request.
    expect(ttsSection.slice(0, ttsSection.indexOf("TTS model"))).not.toContain("Hugging Face");
  });

  it("still offers it under Speech to text", async () => {
    const html = await render();
    const sttSection = html.slice(html.indexOf("Speech to text"));
    expect(sttSection.slice(0, sttSection.indexOf("STT model"))).toContain("Hugging Face");
  });
});
