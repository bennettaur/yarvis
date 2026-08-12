import { beforeEach, describe, expect, it } from "bun:test";
import type { ProviderInfo } from "./chat";
import type { VoiceProviderInfo } from "./voice";
import {
  DEFAULT_VOICE_SETTINGS,
  loadVoiceSettings,
  parseTtsExtras,
  saveVoiceSettings,
  ttsRequestFrom,
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
    capabilities: ["stt"],
    sttModels: ["openai/whisper-large-v3-turbo"],
    ttsModels: ["hexgrad/Kokoro-82M"],
  },
  {
    id: "custom:local",
    label: "Local Ollama",
    available: true,
    capabilities: ["stt", "tts"],
    sttModels: [],
    ttsModels: [],
  },
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
    // Hugging Face is listed first but can only transcribe, so speech falls to
    // the local server — which names its own models, hence the blank field.
    expect(filled.ttsProvider).toBe("custom:local");
    expect(filled.ttsModel).toBe("");
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

  it("moves off a provider that cannot serve the half it was chosen for", () => {
    // An older saved selection points TTS at Hugging Face, whose router refuses
    // every speech model. Keeping it would fail every reply silently.
    const saved = {
      ...DEFAULT_VOICE_SETTINGS,
      ttsProvider: "huggingface",
      ttsModel: "hexgrad/Kokoro-82M",
    };
    const filled = withVoiceDefaults(saved, LLM_PROVIDERS, VOICE_PROVIDERS);
    expect(filled.ttsProvider).toBe("custom:local");
    expect(filled.ttsModel).toBe("");
    // Transcription on the same provider is untouched — it can do that half.
    expect(filled.sttProvider).toBe("huggingface");
  });

  it("leaves TTS blank when nothing can speak", () => {
    const sttOnly = [VOICE_PROVIDERS[0]!];
    const filled = withVoiceDefaults(DEFAULT_VOICE_SETTINGS, LLM_PROVIDERS, sttOnly);
    expect(filled.sttProvider).toBe("huggingface");
    expect(filled.ttsProvider).toBe("");
  });

  it("leaves the toggles alone", () => {
    const saved = { ...DEFAULT_VOICE_SETTINGS, speakReplies: false, handsFree: false };
    const filled = withVoiceDefaults(saved, LLM_PROVIDERS, VOICE_PROVIDERS);
    expect(filled.speakReplies).toBe(false);
    expect(filled.handsFree).toBe(false);
  });
});

describe("parseTtsExtras", () => {
  it("treats blank as no extras at all", () => {
    expect(parseTtsExtras("")).toBeUndefined();
    expect(parseTtsExtras("   ")).toBeUndefined();
  });

  it("parses a scalar object", () => {
    expect(
      parseTtsExtras('{"response_format": "wav", "temperature": 0.5, "stream": false}'),
    ).toEqual({ response_format: "wav", temperature: 0.5, stream: false });
  });

  it("explains malformed JSON instead of throwing a SyntaxError", () => {
    // This is a field someone types into by hand, so the message matters.
    expect(() => parseTtsExtras("{not json")).toThrow(/must be valid JSON/);
  });

  it("rejects a non-object and a nested value", () => {
    expect(() => parseTtsExtras("[1,2]")).toThrow(/must be a JSON object/);
    expect(() => parseTtsExtras('{"opts": {"nested": true}}')).toThrow(/string, number or boolean/);
  });
});

describe("ttsRequestFrom", () => {
  const configured = {
    ...DEFAULT_VOICE_SETTINGS,
    ttsProvider: "custom:local",
    ttsModel: "moss-tts-nano",
  };

  it("carries the reference clip and parsed extras", () => {
    const request = ttsRequestFrom(
      {
        ...configured,
        ttsRefAudio: "data:audio/wav;base64,AAAA",
        ttsExtraBody: '{"response_format": "wav"}',
      },
      "hello",
    );
    expect(request).toEqual({
      provider: "custom:local",
      model: "moss-tts-nano",
      text: "hello",
      voice: undefined,
      refAudio: "data:audio/wav;base64,AAAA",
      extras: { response_format: "wav" },
    });
  });

  it("omits the optional parts when they are blank", () => {
    const request = ttsRequestFrom(configured, "hello");
    expect(request.refAudio).toBeUndefined();
    expect(request.extras).toBeUndefined();
    expect(request.voice).toBeUndefined();
  });

  it("propagates a malformed extras field so the caller can report it once", () => {
    expect(() => ttsRequestFrom({ ...configured, ttsExtraBody: "{oops" }, "hi")).toThrow(
      /must be valid JSON/,
    );
  });
});
