import { useEffect, useState } from "react";
import { useCachedResource } from "../../lib/resourceCache";
import {
  downloadLocalModel,
  getSpeechServer,
  type LocalModelStatus,
  listLocalModels,
  registerSpeechServerProvider,
  type SpeechServerState,
  setSpeechServerPort,
  startSpeechServer,
  stopSpeechServer,
} from "../../lib/speechServer";
import { getVoiceConfig, saveVoiceConfig } from "../../lib/voiceConfig";
import { CARD, errorText } from "./voiceUi";

export const SPEECH_SERVER_KEY = "voice:server";
export const LOCAL_MODELS_KEY = "voice:server-models";

/** How often the status is re-read while something is changing. */
const POLL_MS = 2000;

const STATE_LABEL: Record<SpeechServerState, { text: string; tone: string }> = {
  stopped: { text: "Stopped", tone: "bg-zinc-700 text-zinc-200" },
  starting: { text: "Starting…", tone: "bg-amber-900/60 text-amber-200" },
  running: { text: "Running", tone: "bg-emerald-900/60 text-emerald-200" },
  external: { text: "Running (started elsewhere)", tone: "bg-emerald-900/60 text-emerald-200" },
  failed: { text: "Failed", tone: "bg-red-900/60 text-red-200" },
};

const STARTER_STT = "mlx-community/whisper-large-v3-turbo-asr-fp16";
const STARTER_TTS = "mlx-community/Soprano-1.1-80M-bf16";

/**
 * Runs the mlx-audio server from the app and fetches the models it serves. The
 * sidecar owns the process; this only asks it to start, stop and report.
 */
export default function SpeechServerSection({ onProviderReady }: { onProviderReady: () => void }) {
  const server = useCachedResource(SPEECH_SERVER_KEY, getSpeechServer);
  const models = useCachedResource(LOCAL_MODELS_KEY, listLocalModels);
  const [portText, setPortText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const status = server.data;
  const changing =
    status?.state === "starting" || models.data?.some((m) => m.state === "downloading");

  useEffect(() => {
    if (!changing) return;
    const timer = setInterval(() => {
      void server.refresh();
      void models.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [changing, server.refresh, models.refresh]);

  const savedPort = status?.port;
  useEffect(() => {
    if (savedPort !== undefined) setPortText(String(savedPort));
  }, [savedPort]);

  async function run(action: () => Promise<unknown>, done?: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (done) setMessage({ ok: true, text: done });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
      await Promise.all([server.refresh(), models.refresh()]);
    }
  }

  /**
   * Registers the server as a provider and, where nothing is chosen yet, points
   * both halves of the voice loop at it with the starter models.
   */
  async function useForVoice(): Promise<void> {
    const providerId = await registerSpeechServerProvider();
    const current = await getVoiceConfig();
    await saveVoiceConfig({
      ...(current.sttProvider ? {} : { sttProvider: providerId, sttModel: STARTER_STT }),
      ...(current.ttsProvider ? {} : { ttsProvider: providerId, ttsModel: STARTER_TTS }),
    });
    onProviderReady();
  }

  const running = status?.state === "running" || status?.state === "external";
  const label = status ? STATE_LABEL[status.state] : null;

  return (
    <section className={`${CARD} space-y-4`}>
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium text-zinc-200">Local speech server</h2>
        {label && (
          <span className={`rounded-full px-2 py-0.5 text-xs ${label.tone}`}>{label.text}</span>
        )}
        <span className="text-xs text-zinc-500">
          mlx-audio on Apple Silicon. Needs <code>uv</code> (<code>brew install uv</code>).
        </span>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-zinc-500">Port</span>
          <input
            value={portText}
            onChange={(e) => setPortText(e.target.value.replace(/\D/g, ""))}
            onBlur={() => {
              const port = Number(portText);
              if (!portText) setPortText(String(status?.port ?? ""));
              else if (status && port !== status.port) {
                void run(() => setSpeechServerPort(port));
              }
            }}
            disabled={status?.state === "starting" || status?.state === "running"}
            className="w-24 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:opacity-50"
          />
        </label>
        {status?.state === "running" || status?.state === "starting" ? (
          <button
            type="button"
            onClick={() => void run(stopSpeechServer)}
            disabled={busy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void run(startSpeechServer)}
            disabled={busy || status?.state === "external"}
            title={
              status?.state === "external"
                ? "A server already answers on this port. Yarvis uses it but did not start it."
                : "Start the server. The first start downloads its Python packages."
            }
            className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-900 hover:bg-white disabled:opacity-40"
          >
            Start
          </button>
        )}
        <button
          type="button"
          onClick={() => void run(useForVoice, "Added the server as a speech provider.")}
          disabled={busy || !running}
          title="Add the server under LLM Providers and tag its models for speech."
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
        >
          Use for voice
        </button>
      </div>

      {status?.error && <p className="text-sm text-red-400">{status.error}</p>}
      {message && (
        <p className={`text-sm ${message.ok ? "text-emerald-400" : "text-red-400"}`}>
          {message.text}
        </p>
      )}

      <div className="space-y-2">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500">Models</h3>
        <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
          {(models.data ?? []).map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              onDownload={() => void run(() => downloadLocalModel(model.id))}
            />
          ))}
        </ul>
        <p className="text-xs text-zinc-600">
          Models download into the Hugging Face cache. A model you don't download here downloads on
          its first use instead.
        </p>
      </div>

      {status && status.log.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500">
            Server output
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-zinc-950 p-2 text-xs text-zinc-400">
            {status.log.join("\n")}
          </pre>
        </details>
      )}
    </section>
  );
}

function ModelRow({ model, onDownload }: { model: LocalModelStatus; onDownload: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs uppercase text-zinc-400">
        {model.kind}
      </span>
      <span className="font-mono text-xs text-zinc-200">{model.id}</span>
      {model.cloning && <span className="text-xs text-sky-300">clones voices</span>}
      <span className="text-xs text-zinc-500">{model.note}</span>
      <span className="ml-auto text-xs">
        {model.state === "downloaded" && <span className="text-emerald-400">Downloaded</span>}
        {model.state === "downloading" && <span className="text-amber-300">Downloading…</span>}
        {(model.state === "absent" || model.state === "failed") && (
          <button
            type="button"
            onClick={onDownload}
            title={model.error ?? undefined}
            className="rounded-md border border-zinc-700 px-2 py-1 hover:bg-zinc-800"
          >
            {model.state === "failed" ? "Retry download" : "Download"}
          </button>
        )}
      </span>
    </li>
  );
}
