import { useCallback, useEffect, useState } from "react";
import { playAudioBlob } from "../lib/audioPlayback";
import { listVoiceProviders, speak, type VoiceProviderInfo } from "../lib/voice";
import {
  DEFAULT_VOICE_CONFIG,
  getVoiceConfig,
  saveVoiceConfig,
  speechRequestFor,
  type VoiceConfig,
} from "../lib/voiceConfig";

/**
 * Which backends carry speech, for every surface that uses it — the chat tabs
 * today, the Telegram bot once it grows voice notes (#226). One configuration
 * rather than one per surface, which is why it lives in the sidecar rather than
 * in this window's storage.
 *
 * The model that *answers* is not set here: a spoken turn goes to whatever
 * model the chat it was spoken into is already using.
 */

/** Phrase the test button speaks. Long enough to judge the voice by. */
const TEST_PHRASE = "Voice output is working. This is how I will read replies back to you.";

/**
 * Gemini's prebuilt voice names, offered as suggestions when it is the chosen
 * backend. Unlike the OpenAI-shaped servers, Gemini has no default voice: a
 * request with no `voiceConfig` is rejected, so `GeminiSpeech` falls back to
 * Kore and naming one here is how the user picks something else.
 */
const GEMINI_VOICES = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede"];

/** Largest reference clip accepted, before base64 inflates it by a third. */
const MAX_REF_AUDIO_BYTES = 3 * 1024 * 1024;

const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-600">{hint}</span>}
    </label>
  );
}

export default function VoiceSection() {
  const [config, setConfig] = useState<VoiceConfig>(DEFAULT_VOICE_CONFIG);
  const [providers, setProviders] = useState<VoiceProviderInfo[]>([]);
  const [extrasText, setExtrasText] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [saved, catalog] = await Promise.all([getVoiceConfig(), listVoiceProviders()]);
        setConfig(saved);
        setProviders(catalog);
        setExtrasText(
          Object.keys(saved.ttsExtras).length ? JSON.stringify(saved.ttsExtras, null, 2) : "",
        );
      } catch (e) {
        setStatus({ ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  const save = useCallback(async (patch: Partial<VoiceConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
    try {
      setConfig(await saveVoiceConfig(patch));
      setStatus(null);
    } catch (e) {
      setStatus({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  /** Only providers that serve this half; Hugging Face cannot speak. */
  const optionsFor = (capability: "stt" | "tts") =>
    providers
      .filter((p) => p.capabilities.includes(capability))
      .map((p) => (
        <option key={p.id} value={p.id} disabled={!p.available}>
          {p.label}
          {p.available ? "" : " (no key)"}
        </option>
      ));

  const suggestionsFor = (capability: "stt" | "tts") => {
    const chosen = providers.find(
      (p) => p.id === (capability === "stt" ? config.sttProvider : config.ttsProvider),
    );
    return capability === "stt" ? (chosen?.sttModels ?? []) : (chosen?.ttsModels ?? []);
  };

  async function pickReferenceClip(file: File | undefined): Promise<void> {
    if (!file) return;
    if (file.size > MAX_REF_AUDIO_BYTES) {
      setStatus({
        ok: false,
        message: `Reference clip is too large (${Math.round(file.size / 1024)} KB). A few seconds of speech is enough.`,
      });
      return;
    }
    const reader = new FileReader();
    const dataUri = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("could not read that file"));
      reader.readAsDataURL(file);
    }).catch((e: Error) => {
      setStatus({ ok: false, message: e.message });
      return "";
    });
    if (dataUri) await save({ ttsRefAudio: dataUri });
  }

  /** Parses the extras box and saves it, reporting a syntax error in place. */
  async function saveExtras(): Promise<void> {
    const text = extrasText.trim();
    if (!text) {
      await save({ ttsExtras: {} });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setStatus({ ok: false, message: 'Extra fields must be valid JSON, e.g. {"speed": 1.1}' });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setStatus({ ok: false, message: "Extra fields must be a JSON object" });
      return;
    }
    await save({ ttsExtras: parsed as VoiceConfig["ttsExtras"] });
  }

  /**
   * Speaks a fixed phrase with the saved settings. Without it, the only way to
   * find a configuration wrong is to finish a turn and hear nothing — and a bad
   * model, a missing key and a cold server all look identical from there.
   */
  async function testVoice(): Promise<void> {
    setTesting(true);
    setStatus(null);
    try {
      await playAudioBlob(await speak(speechRequestFor(config, TEST_PHRASE)));
      setStatus({ ok: true, message: "Played the test phrase." });
    } catch (e) {
      setStatus({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-sm font-medium text-zinc-200">Voice</h2>
        <p className="text-xs text-zinc-500">
          Speech in and out, shared by every surface that uses it. The model that answers is
          whichever one the chat you spoke into is set to. Which models each backend offers here is
          set under LLM Providers — only models tagged for speech appear.
        </p>
      </header>

      <div className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:grid-cols-3">
        <Field label="Speech to text">
          <select
            value={config.sttProvider}
            onChange={(e) => void save({ sttProvider: e.target.value, sttModel: "" })}
            className={FIELD}
          >
            <option value="">— provider —</option>
            {optionsFor("stt")}
          </select>
        </Field>
        <Field label="STT model" hint="Whatever the backend calls it.">
          <input
            value={config.sttModel}
            onChange={(e) => setConfig((prev) => ({ ...prev, sttModel: e.target.value }))}
            onBlur={(e) => void save({ sttModel: e.target.value })}
            list="yarvis-stt-models"
            placeholder="openai/whisper-large-v3-turbo"
            className={FIELD}
          />
          <datalist id="yarvis-stt-models">
            {suggestionsFor("stt").map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Spoken language" hint="ISO-639-1, or blank to auto-detect.">
          <input
            value={config.sttLanguage}
            onChange={(e) => setConfig((prev) => ({ ...prev, sttLanguage: e.target.value.trim() }))}
            onBlur={(e) => void save({ sttLanguage: e.target.value.trim() })}
            placeholder="auto-detect"
            maxLength={5}
            className={FIELD}
          />
        </Field>

        <Field label="Text to speech">
          <select
            value={config.ttsProvider}
            onChange={(e) => void save({ ttsProvider: e.target.value, ttsModel: "" })}
            className={FIELD}
          >
            <option value="">— provider —</option>
            {optionsFor("tts")}
          </select>
        </Field>
        <Field label="TTS model">
          <input
            value={config.ttsModel}
            onChange={(e) => setConfig((prev) => ({ ...prev, ttsModel: e.target.value }))}
            onBlur={(e) => void save({ ttsModel: e.target.value })}
            list="yarvis-tts-models"
            placeholder="mlx-community/Soprano-1.1-80M-bf16"
            className={FIELD}
          />
          <datalist id="yarvis-tts-models">
            {suggestionsFor("tts").map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Voice" hint="Ignored by voice-cloning models.">
          <input
            value={config.ttsVoice}
            onChange={(e) => setConfig((prev) => ({ ...prev, ttsVoice: e.target.value }))}
            onBlur={(e) => void save({ ttsVoice: e.target.value })}
            list="yarvis-tts-voices"
            placeholder={config.ttsProvider === "gemini" ? "Kore" : "provider default"}
            className={FIELD}
          />
          <datalist id="yarvis-tts-voices">
            {(config.ttsProvider === "gemini" ? GEMINI_VOICES : []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </Field>
      </div>

      <details className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500">
          Voice cloning &amp; server-specific fields
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Reference clip"
            hint={
              config.ttsRefAudio
                ? `Loaded (${Math.round(config.ttsRefAudio.length / 1024)} KB), sent as ref_audio.`
                : "Only for models that clone a voice, e.g. MOSS-TTS-Nano."
            }
          >
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => void pickReferenceClip(e.target.files?.[0])}
                className="text-xs text-zinc-400 file:mr-2 file:rounded-md file:border-0 file:bg-zinc-800 file:px-2 file:py-1 file:text-xs file:text-zinc-200"
              />
              {config.ttsRefAudio && (
                <button
                  type="button"
                  onClick={() => void save({ ttsRefAudio: "" })}
                  className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                >
                  Clear
                </button>
              )}
            </div>
          </Field>
          <Field label="Extra request fields (JSON)" hint="Saved when you click away.">
            <textarea
              value={extrasText}
              onChange={(e) => setExtrasText(e.target.value)}
              onBlur={() => void saveExtras()}
              rows={3}
              placeholder='{"speed": 1.1}'
              className={`${FIELD} font-mono`}
            />
          </Field>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={config.speakReplies}
            onChange={(e) => void save({ speakReplies: e.target.checked })}
          />
          Speak replies by default
        </label>
        <label
          className="flex items-center gap-2 text-sm text-zinc-300"
          title="Anything audible in the room can become a turn you never addressed to the assistant."
        >
          <input
            type="checkbox"
            checked={config.handsFree}
            onChange={(e) => void save({ handsFree: e.target.checked })}
          />
          Hands-free by default
        </label>
        <button
          type="button"
          onClick={() => void testVoice()}
          disabled={testing || !config.ttsProvider || !config.ttsModel}
          className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
        >
          {testing ? "Testing…" : "Test voice"}
        </button>
      </div>

      {status && (
        <p className={`text-sm ${status.ok ? "text-emerald-400" : "text-red-400"}`}>
          {status.message}
        </p>
      )}
    </section>
  );
}
