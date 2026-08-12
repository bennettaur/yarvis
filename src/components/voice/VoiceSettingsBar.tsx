import type { ProviderInfo } from "../../lib/chat";
import type { VoiceProviderInfo } from "../../lib/voice";
import type { VoiceSettings } from "../../lib/voiceSettings";

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

  const llmModels = llmProviders.find((p) => p.id === settings.llmProvider)?.models ?? [];
  const sttModels = voiceProviders.find((p) => p.id === settings.sttProvider)?.sttModels ?? [];
  const ttsModels = voiceProviders.find((p) => p.id === settings.ttsProvider)?.ttsModels ?? [];

  const speechProviderOptions = voiceProviders.map((p) => (
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
            {speechProviderOptions}
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
            {speechProviderOptions}
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
      </div>

      <div className="flex flex-wrap gap-4">
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
      </div>
    </div>
  );
}
