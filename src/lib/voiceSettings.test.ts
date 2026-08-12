import { beforeEach, describe, expect, it } from "bun:test";
import type { ProviderInfo } from "./chat";
import type { VoiceProviderInfo } from "./voice";
import {
  DEFAULT_VOICE_SETTINGS,
  loadVoiceSettings,
  saveVoiceSettings,
  VOICE_SETTINGS_KEY,
  withVoiceDefaults,
} from "./voiceSettings";

const LLM_PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", label: "Anthropic", models: [], available: false },
  { id: "cerebras", label: "Cerebras", models: ["zai-glm-4.6"], available: true },
  { id: "custom:local", label: "Local Ollama", models: ["gemma-3n-e4b"], available: true },
];

const VOICE_PROVIDERS: VoiceProviderInfo[] = [
  {
    id: "huggingface",
    label: "Hugging Face",
    available: true,
    sttModels: ["openai/whisper-large-v3-turbo"],
    ttsModels: ["hexgrad/Kokoro-82M"],
  },
  { id: "custom:local", label: "Local Ollama", available: true, sttModels: [], ttsModels: [] },
];

beforeEach(() => {
  localStorage.clear();
});

describe("loadVoiceSettings", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it("round-trips through save", () => {
    const settings = { ...DEFAULT_VOICE_SETTINGS, llmProvider: "cerebras", handsFree: false };
    saveVoiceSettings(settings);
    expect(loadVoiceSettings()).toEqual(settings);
  });

  it("falls back per field rather than discarding a partly-broken blob", () => {
    localStorage.setItem(
      VOICE_SETTINGS_KEY,
      JSON.stringify({ llmProvider: "cerebras", speakReplies: "yes" }),
    );
    const loaded = loadVoiceSettings();
    expect(loaded.llmProvider).toBe("cerebras");
    expect(loaded.speakReplies).toBe(DEFAULT_VOICE_SETTINGS.speakReplies);
  });

  it("survives a value that is not JSON", () => {
    localStorage.setItem(VOICE_SETTINGS_KEY, "{not json");
    expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
  });
});

describe("withVoiceDefaults", () => {
  it("picks the first usable provider and its first model when nothing is chosen", () => {
    const filled = withVoiceDefaults(DEFAULT_VOICE_SETTINGS, LLM_PROVIDERS, VOICE_PROVIDERS);
    // Anthropic is listed first but has no key, so it isn't chosen.
    expect(filled.llmProvider).toBe("cerebras");
    expect(filled.llmModel).toBe("zai-glm-4.6");
    expect(filled.sttProvider).toBe("huggingface");
    expect(filled.sttModel).toBe("openai/whisper-large-v3-turbo");
    expect(filled.ttsModel).toBe("hexgrad/Kokoro-82M");
  });

  it("keeps a saved selection that is still configured", () => {
    const saved = {
      ...DEFAULT_VOICE_SETTINGS,
      llmProvider: "custom:local",
      llmModel: "gemma-3n-e4b",
      sttProvider: "custom:local",
      sttModel: "faster-whisper-large-v3",
    };
    const filled = withVoiceDefaults(saved, LLM_PROVIDERS, VOICE_PROVIDERS);
    expect(filled.llmProvider).toBe("custom:local");
    expect(filled.llmModel).toBe("gemma-3n-e4b");
    // A model the catalog doesn't suggest is still the user's choice.
    expect(filled.sttModel).toBe("faster-whisper-large-v3");
  });

  it("drops a selection whose provider is gone", () => {
    const saved = {
      ...DEFAULT_VOICE_SETTINGS,
      sttProvider: "custom:deleted",
      sttModel: "whisper-1",
    };
    const filled = withVoiceDefaults(saved, LLM_PROVIDERS, VOICE_PROVIDERS);
    expect(filled.sttProvider).toBe("huggingface");
    expect(filled.sttModel).toBe("openai/whisper-large-v3-turbo");
  });

  it("leaves everything blank when nothing is configured", () => {
    const filled = withVoiceDefaults(DEFAULT_VOICE_SETTINGS, [], []);
    expect(filled.llmProvider).toBe("");
    expect(filled.sttProvider).toBe("");
    expect(filled.ttsModel).toBe("");
  });

  it("moves off a provider whose key was removed", () => {
    const saved = { ...DEFAULT_VOICE_SETTINGS, sttProvider: "huggingface", sttModel: "whisper-1" };
    const unkeyed: VoiceProviderInfo[] = [
      { ...VOICE_PROVIDERS[0]!, available: false },
      VOICE_PROVIDERS[1]!,
    ];
    const filled = withVoiceDefaults(saved, LLM_PROVIDERS, unkeyed);
    // Keeping it would 400 every request with nothing on screen to explain it.
    expect(filled.sttProvider).toBe("custom:local");
  });

  it("leaves the toggles alone", () => {
    const saved = { ...DEFAULT_VOICE_SETTINGS, speakReplies: false, handsFree: false };
    const filled = withVoiceDefaults(saved, LLM_PROVIDERS, VOICE_PROVIDERS);
    expect(filled.speakReplies).toBe(false);
    expect(filled.handsFree).toBe(false);
  });
});
