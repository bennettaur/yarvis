import { useState } from "react";
import { playAudioBlob } from "../../lib/audioPlayback";
import type { ProviderInfo } from "../../lib/chat";
import { speak, type VoiceProviderInfo } from "../../lib/voice";
import { ttsRequestFrom, type VoiceSettings } from "../../lib/voiceSettings";

/**
 * Provider/model selection for the voice loop: which model answers, which
 * backend hears, which one speaks. The three are chosen independently — the
 * whole point of the voice surface having its own picker is that it need not
 * run on whatever the Chat tab is set to.
 *
 * Speech models are typed rather than picked from a fixed list: hosted
 * catalogues move, and a local server's model names are its own. The provider's
 * suggestions ride along as a datalist.
 */

/** Phrase the test button speaks. Long enough to judge the voice by. */
const TEST_PHRASE = "Voice output is working. This is how I will read replies back to you.";

/** Largest reference clip accepted, before base64 inflates it by a third. */
const MAX_REF_AUDIO_BYTES = 3 * 1024 * 1024;

const FIELD =
  "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-300" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export default function VoiceSettingsBar({
  settings,
  onChange,
  llmProviders,
  voiceProviders,
}: {
  settings: VoiceSettings;
  onChange: (settings: VoiceSettings) => void;
  llmProviders: ProviderInfo[];
  voiceProviders: VoiceProviderInfo[];
}) {
  const patch = (fields: Partial<VoiceSettings>) => onChange({ ...settings, ...fields });

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  /** Reads a chosen clip as the base64 data URI the synthesis route expects. */
  async function pickReferenceClip(file: File | undefined): Promise<void> {
    if (!file) return;
    if (file.size > MAX_REF_AUDIO_BYTES) {
      setTestResult({
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
      setTestResult({ ok: false, message: e.message });
      return "";
    });
    if (dataUri) {
      setTestResult(null);
      patch({ ttsRefAudio: dataUri });
    }
  }

  /**
   * Speaks a fixed phrase with the current settings. Without this the only way
   * to find out a TTS configuration is wrong is to finish a whole turn and hear
   * nothing — and a bad model, a missing key and a cold server all look alike.
   */
  async function testVoice(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      await playAudioBlob(await speak(ttsRequestFrom(settings, TEST_PHRASE)));
      setTestResult({ ok: true, message: "Played the test phrase." });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  const llmModels = llmProviders.find((p) => p.id === settings.llmProvider)?.models ?? [];
  const sttModels = voiceProviders.find((p) => p.id === settings.sttProvider)?.sttModels ?? [];
  const ttsModels = voiceProviders.find((p) => p.id === settings.ttsProvider)?.ttsModels ?? [];

  /**
   * Only providers that serve this half. Listing one that can't — Hugging Face
   * under Text to speech — offers a choice whose every request fails.
   */
  const speechProviderOptions = (capability: "stt" | "tts") =>
    voiceProviders
      .filter((p) => p.capabilities.includes(capability))
      .map((p) => (
        <option key={p.id} value={p.id} disabled={!p.available}>
          {p.label}
          {p.available ? "" : " (no key)"}
        </option>
      ));

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Answering model">
          <select
            value={settings.llmProvider}
            onChange={(e) => {
              const id = e.target.value;
              const models = llmProviders.find((p) => p.id === id)?.models ?? [];
              patch({ llmProvider: id, llmModel: models[0] ?? "" });
            }}
            className={FIELD}
          >
            <option value="">— provider —</option>
            {llmProviders.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}
                {p.available ? "" : " (no key)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model">
          <select
            value={settings.llmModel}
            onChange={(e) => patch({ llmModel: e.target.value })}
            className={FIELD}
          >
            {llmModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Speech to text">
          <select
            value={settings.sttProvider}
            onChange={(e) => {
              const id = e.target.value;
              const models = voiceProviders.find((p) => p.id === id)?.sttModels ?? [];
              patch({ sttProvider: id, sttModel: models[0] ?? "" });
            }}
            className={FIELD}
          >
            <option value="">— provider —</option>
            {speechProviderOptions("stt")}
          </select>
        </Field>
        <Field label="STT model">
          <input
            value={settings.sttModel}
            onChange={(e) => patch({ sttModel: e.target.value })}
            list="yarvis-stt-models"
            placeholder="openai/whisper-large-v3-turbo"
            className={FIELD}
          />
          <datalist id="yarvis-stt-models">
            {sttModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>

        <Field label="Text to speech">
          <select
            value={settings.ttsProvider}
            onChange={(e) => {
              const id = e.target.value;
              const models = voiceProviders.find((p) => p.id === id)?.ttsModels ?? [];
              patch({ ttsProvider: id, ttsModel: models[0] ?? "" });
            }}
            className={FIELD}
          >
            <option value="">— provider —</option>
            {speechProviderOptions("tts")}
          </select>
        </Field>
        <Field label="TTS model">
          <input
            value={settings.ttsModel}
            onChange={(e) => patch({ ttsModel: e.target.value })}
            list="yarvis-tts-models"
            placeholder="hexgrad/Kokoro-82M"
            className={FIELD}
          />
          <datalist id="yarvis-tts-models">
            {ttsModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Voice">
          <input
            value={settings.ttsVoice}
            onChange={(e) => patch({ ttsVoice: e.target.value })}
            placeholder="provider default"
            className={FIELD}
          />
        </Field>
        <Field label="Spoken language">
          <input
            value={settings.sttLanguage}
            onChange={(e) => patch({ sttLanguage: e.target.value.trim() })}
            placeholder="auto-detect"
            maxLength={5}
            className={FIELD}
          />
        </Field>
      </div>

      {/* Cloning servers take a reference clip instead of a voice id, and some
          want body fields of their own; both are per-server, so they sit apart
          from the pickers rather than beside them. */}
      <details className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500">
          Voice cloning &amp; server-specific fields
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Reference clip">
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => void pickReferenceClip(e.target.files?.[0])}
                className="text-xs text-zinc-400 file:mr-2 file:rounded-md file:border-0 file:bg-zinc-800 file:px-2 file:py-1 file:text-xs file:text-zinc-200"
              />
              {settings.ttsRefAudio && (
                <button
                  type="button"
                  onClick={() => patch({ ttsRefAudio: "" })}
                  className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                >
                  Clear
                </button>
              )}
            </div>
            <span className="text-xs text-zinc-500">
              {settings.ttsRefAudio
                ? `Loaded (${Math.round(settings.ttsRefAudio.length / 1024)} KB). Sent as ref_audio.`
                : "Only for models that clone a voice, e.g. MOSS-TTS-Nano."}
            </span>
          </Field>
          <Field label="Extra request fields (JSON)">
            <textarea
              value={settings.ttsExtraBody}
              onChange={(e) => patch({ ttsExtraBody: e.target.value })}
              rows={2}
              placeholder='{"response_format": "wav"}'
              className={`${FIELD} font-mono`}
            />
          </Field>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-4">
        <Toggle
          label="Speak replies"
          checked={settings.speakReplies}
          onChange={(speakReplies) => patch({ speakReplies })}
          title="Synthesize each finished sentence as the reply streams in."
        />
        <Toggle
          label="Hands-free"
          checked={settings.handsFree}
          onChange={(handsFree) => patch({ handsFree })}
          title="End a turn on silence and re-open the mic once the reply finishes."
        />
        <button
          type="button"
          onClick={() => void testVoice()}
          disabled={testing || !settings.ttsProvider || !settings.ttsModel}
          className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
        >
          {testing ? "Testing…" : "Test voice"}
        </button>
      </div>

      {testResult && (
        <p className={`text-sm ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}>
          {testResult.message}
        </p>
      )}
    </div>
  );
}
