import { useRef, useState } from "react";
import { toSpeechWav } from "../../lib/audioEncoding";
import { playAudioBlob } from "../../lib/audioPlayback";
import { primeCache } from "../../lib/resourceCache";
import { useVoiceRecorder } from "../../lib/useVoiceRecorder";
import { speak, type VoiceProviderInfo } from "../../lib/voice";
import type { VoiceConfig } from "../../lib/voiceConfig";
import {
  createVoiceProfile,
  deleteVoiceClip,
  deleteVoiceProfile,
  type RefAudioMode,
  uploadVoiceClip,
  type VoiceProfile,
} from "../../lib/voiceStudio";
import { BUTTON, CARD, errorText, FIELD, Field } from "./voiceUi";

export const VOICE_PROFILES_KEY = "voice:profiles";

/** A cloning clip only needs five to ten seconds; this leaves room for a slow start. */
const MAX_CLIP_MS = 15_000;

/** Largest file accepted for upload, before it is converted to 16 kHz WAV. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const TEST_PHRASE = "Hello. This is how this voice sounds.";

const EMPTY_FORM = {
  name: "",
  provider: "",
  model: "",
  voice: "",
  refAudioMode: "path" as RefAudioMode,
};

/**
 * Saved voices: create one, give it a clip to clone from (recorded here or
 * uploaded), and pick which one replies are spoken in.
 */
export default function VoicesSection({
  voices,
  providers,
  config,
  onConfigChange,
}: {
  voices: VoiceProfile[];
  providers: VoiceProviderInfo[];
  config: VoiceConfig;
  onConfigChange: (patch: Partial<VoiceConfig>) => Promise<void>;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const recordingForRef = useRef<string | null>(null);

  const ttsProviders = providers.filter((p) => p.capabilities.includes("tts"));
  const modelSuggestions = providers.find((p) => p.id === form.provider)?.ttsModels ?? [];

  const replaceVoice = (row: VoiceProfile) =>
    primeCache<VoiceProfile[]>(VOICE_PROFILES_KEY, (current) =>
      (current ?? []).map((v) => (v.id === row.id ? row : v)),
    );

  async function withStatus(id: string | null, action: () => Promise<void>): Promise<void> {
    setBusyId(id);
    setStatus(null);
    try {
      await action();
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusyId(null);
    }
  }

  async function storeClip(id: string, audio: Blob): Promise<void> {
    await withStatus(id, async () => {
      replaceVoice(await uploadVoiceClip(id, await toSpeechWav(audio)));
      setStatus({ ok: true, text: "Saved the clip." });
    });
  }

  const recorder = useVoiceRecorder({
    onUtterance: (audio) => {
      const id = recordingForRef.current;
      recordingForRef.current = null;
      setRecordingFor(null);
      if (id) void storeClip(id, audio);
    },
    autoStopSilenceMs: null,
    maxUtteranceMs: MAX_CLIP_MS,
  });

  async function toggleRecording(id: string): Promise<void> {
    if (recordingFor === id) {
      recorder.stop();
      return;
    }
    recordingForRef.current = id;
    setRecordingFor(id);
    if (!(await recorder.start())) {
      recordingForRef.current = null;
      setRecordingFor(null);
    }
  }

  async function create(): Promise<void> {
    await withStatus(null, async () => {
      const row = await createVoiceProfile({ ...form, extras: {} });
      primeCache<VoiceProfile[]>(VOICE_PROFILES_KEY, (current) => [...(current ?? []), row]);
      setForm(EMPTY_FORM);
    });
  }

  async function remove(voice: VoiceProfile): Promise<void> {
    await withStatus(voice.id, async () => {
      await deleteVoiceProfile(voice.id);
      primeCache<VoiceProfile[]>(VOICE_PROFILES_KEY, (current) =>
        (current ?? []).filter((v) => v.id !== voice.id),
      );
      if (config.activeVoiceId === voice.id) await onConfigChange({ activeVoiceId: "" });
    });
  }

  async function test(voice: VoiceProfile): Promise<void> {
    await withStatus(voice.id, async () => {
      await playAudioBlob(await speak({ voiceId: voice.id, text: TEST_PHRASE }));
    });
  }

  return (
    <section className={`${CARD} space-y-4`}>
      <header className="space-y-1">
        <h2 className="text-sm font-medium text-zinc-200">Voices</h2>
        <p className="text-xs text-zinc-500">
          A saved voice is a text-to-speech setup with an optional clip to clone. Activate one to
          speak replies in it; with none active, replies use Settings → Voice.
        </p>
      </header>

      <ul className="space-y-2">
        {voices.length === 0 && <li className="text-sm text-zinc-500">No saved voices yet.</li>}
        {voices.map((voice) => {
          const active = config.activeVoiceId === voice.id;
          const busy = busyId === voice.id;
          return (
            <li
              key={voice.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 px-3 py-2"
            >
              <span className="text-sm text-zinc-200">{voice.name}</span>
              {active && (
                <span className="rounded-full bg-emerald-900/60 px-2 py-0.5 text-xs text-emerald-200">
                  Active
                </span>
              )}
              <span className="font-mono text-xs text-zinc-500">{voice.model}</span>
              <span className="text-xs text-zinc-500">
                {voice.hasClip ? "Clip saved" : "No clip"}
              </span>
              <span className="ml-auto flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void toggleRecording(voice.id)}
                  disabled={busy || (recordingFor !== null && recordingFor !== voice.id)}
                  className={BUTTON}
                >
                  {recordingFor === voice.id ? "Stop recording" : "Record clip"}
                </button>
                <label className={`${BUTTON} cursor-pointer`}>
                  Upload clip
                  <input
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      if (file.size > MAX_UPLOAD_BYTES) {
                        setStatus({ ok: false, text: "That file is too large for a short clip." });
                        return;
                      }
                      void storeClip(voice.id, file);
                    }}
                  />
                </label>
                {voice.hasClip && (
                  <button
                    type="button"
                    onClick={() =>
                      void withStatus(voice.id, async () =>
                        replaceVoice(await deleteVoiceClip(voice.id)),
                      )
                    }
                    disabled={busy}
                    className={BUTTON}
                  >
                    Remove clip
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void test(voice)}
                  disabled={busy}
                  className={BUTTON}
                >
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => void onConfigChange({ activeVoiceId: active ? "" : voice.id })}
                  className={BUTTON}
                >
                  {active ? "Deactivate" : "Activate"}
                </button>
                <button
                  type="button"
                  onClick={() => void remove(voice)}
                  disabled={busy}
                  className={`${BUTTON} text-red-300`}
                >
                  Delete
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {recorder.error && <p className="text-sm text-red-400">{recorder.error}</p>}

      <div className="grid gap-3 border-t border-zinc-800 pt-4 sm:grid-cols-5">
        <Field label="Name">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="My voice"
            className={FIELD}
          />
        </Field>
        <Field label="Provider">
          <select
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value, model: "" })}
            className={FIELD}
          >
            <option value="">— provider —</option>
            {ttsProviders.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model">
          <input
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            list="yarvis-voice-profile-models"
            placeholder="mlx-community/MOSS-TTS-Nano-100M"
            className={FIELD}
          />
          <datalist id="yarvis-voice-profile-models">
            {modelSuggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Voice" hint="Ignored by cloning models.">
          <input
            value={form.voice}
            onChange={(e) => setForm({ ...form, voice: e.target.value })}
            placeholder="provider default"
            className={FIELD}
          />
        </Field>
        <Field label="Clip sent as" hint="Path for mlx-audio, inline for vLLM.">
          <select
            value={form.refAudioMode}
            onChange={(e) => setForm({ ...form, refAudioMode: e.target.value as RefAudioMode })}
            className={FIELD}
          >
            <option value="path">File path</option>
            <option value="inline">Inline audio</option>
          </select>
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void create()}
          disabled={!form.name.trim() || !form.provider || !form.model.trim() || busyId !== null}
          className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-900 hover:bg-white disabled:opacity-40"
        >
          Add voice
        </button>
        {status && (
          <p className={`text-sm ${status.ok ? "text-emerald-400" : "text-red-400"}`}>
            {status.text}
          </p>
        )}
      </div>
    </section>
  );
}
