import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import type { ProviderInfo } from "../../lib/chat";
import { primeCache } from "../../lib/resourceCache";
import type { VoiceConfig } from "../../lib/voiceConfig";
import {
  DEFAULT_STUDIO_VOICE,
  fetchTakeAudio,
  generateTakes,
  type StudioResult,
  type StudioTake,
  saveTake,
  type VoiceProfile,
} from "../../lib/voiceStudio";
import { BUTTON, CARD, errorText, FIELD, Field } from "./voiceUi";

export const STUDIO_TAKES_KEY = "voice:studio-takes";

/** Matches the sidecar's cap on one synthesis call. */
const MAX_TEXT_CHARS = 2000;

/**
 * Type some text, hear it in several voices side by side, and keep the takes
 * worth keeping. Each generation replaces the last batch; a saved take is
 * copied to Downloads and outlives it.
 */
export default function VoiceStudio({
  voices,
  takes,
  chatProviders,
  config,
  onConfigChange,
}: {
  voices: VoiceProfile[];
  takes: StudioTake[];
  chatProviders: ProviderInfo[];
  config: VoiceConfig;
  onConfigChange: (patch: Partial<VoiceConfig>) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([DEFAULT_STUDIO_VOICE]);
  const [language, setLanguage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<Pick<StudioResult, "failures" | "translation"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = [{ id: DEFAULT_STUDIO_VOICE, name: "Default (Settings → Voice)" }, ...voices];
  const translationModels =
    chatProviders.find((p) => p.id === config.translationProvider)?.models ?? [];

  function toggle(id: string): void {
    setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }

  async function generate(): Promise<void> {
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const out = await generateTakes({
        text,
        voiceIds: selected,
        language: language.trim() || undefined,
      });
      primeCache<StudioTake[]>(STUDIO_TAKES_KEY, out.takes);
      setResult({ failures: out.failures, translation: out.translation });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className={`${CARD} space-y-4`}>
      <header className="space-y-1">
        <h2 className="text-sm font-medium text-zinc-200">Studio</h2>
        <p className="text-xs text-zinc-500">
          Generating clears the previous takes. Save a take to keep it: it is copied to
          Downloads/Yarvis Voice.
        </p>
      </header>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={MAX_TEXT_CHARS}
        placeholder="Type what the voices should say."
        className={FIELD}
      />

      <div className="flex flex-wrap gap-3">
        {options.map((voice) => (
          <label key={voice.id} className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={selected.includes(voice.id)}
              onChange={() => toggle(voice.id)}
            />
            {voice.name}
          </label>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Translate to" hint="Blank speaks the text as typed.">
          <input
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="e.g. French"
            maxLength={40}
            className={FIELD}
          />
        </Field>
        <Field label="Translation provider">
          <select
            value={config.translationProvider}
            onChange={(e) =>
              void onConfigChange({ translationProvider: e.target.value, translationModel: "" })
            }
            className={FIELD}
          >
            <option value="">— provider —</option>
            {chatProviders.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Translation model">
          <select
            value={config.translationModel}
            onChange={(e) => void onConfigChange({ translationModel: e.target.value })}
            className={FIELD}
          >
            <option value="">— model —</option>
            {translationModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <button
        type="button"
        onClick={() => void generate()}
        disabled={generating || !text.trim() || selected.length === 0}
        className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-900 hover:bg-white disabled:opacity-40"
      >
        {generating ? "Generating…" : "Generate"}
      </button>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {result?.translation && (
        <p className="rounded-md bg-zinc-950 p-2 text-sm text-zinc-300">{result.translation}</p>
      )}
      {result?.failures.map((f) => (
        <p key={f.voiceId} className="text-sm text-red-400">
          {f.voiceName}: {f.error}
        </p>
      ))}

      <ul className="space-y-2">
        {takes.map((take) => (
          <TakeRow key={take.file} take={take} />
        ))}
      </ul>
    </section>
  );
}

function TakeRow({ take }: { take: StudioTake }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The audio route needs the bearer token, so the take is fetched and played
  // from an object URL rather than pointed at directly.
  useEffect(() => {
    let objectUrl: string | null = null;
    let active = true;
    fetchTakeAudio(take.file)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e) => active && setError(errorText(e)));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [take.file]);

  async function save(): Promise<void> {
    try {
      const saved = await saveTake(take.file);
      primeCache<StudioTake[]>(STUDIO_TAKES_KEY, (current) =>
        (current ?? []).map((t) => (t.file === saved.file ? saved : t)),
      );
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 px-3 py-2">
      <span className="w-40 truncate text-sm text-zinc-200">{take.voiceName}</span>
      {url ? (
        // biome-ignore lint/a11y/useMediaCaption: generated speech has no caption track.
        <audio controls src={url} className="h-8" />
      ) : (
        <span className="text-xs text-zinc-500">{error ?? "Loading…"}</span>
      )}
      <span className="ml-auto flex items-center gap-2">
        {take.savedPath ? (
          <button
            type="button"
            onClick={() => void revealItemInDir(take.savedPath ?? "")}
            title={take.savedPath}
            className={BUTTON}
          >
            Show in Finder
          </button>
        ) : (
          <button type="button" onClick={() => void save()} className={BUTTON}>
            Save
          </button>
        )}
      </span>
    </li>
  );
}
