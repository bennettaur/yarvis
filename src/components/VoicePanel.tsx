import { useCallback, useEffect, useRef, useState } from "react";
import { playAudioBlob } from "../lib/audioPlayback";
import {
  createSession,
  listProviders,
  type ProviderInfo,
  streamChat,
  type ThreadMessage,
} from "../lib/chat";
import { createSentenceSplitter } from "../lib/speechChunks";
import { createSpeechQueue, type SpeechQueue } from "../lib/speechQueue";
import { useVoiceRecorder } from "../lib/useVoiceRecorder";
import { listVoiceProviders, speak, transcribe, type VoiceProviderInfo } from "../lib/voice";
import {
  loadVoiceSettings,
  saveVoiceSettings,
  type VoiceSettings,
  withVoiceDefaults,
} from "../lib/voiceSettings";
import ChatMessages from "./ChatMessages";
import MicButton from "./voice/MicButton";
import VoiceSettingsBar from "./voice/VoiceSettingsBar";

/**
 * The voice loop: speak, get transcribed, have the agent answer, hear it back.
 *
 * It drives the same chat agent as the Chat tab (same sessions, same tools,
 * same memory) through the existing stream, and only adds the two speech hops
 * around it. Those hops are deliberately per-sentence rather than per-reply —
 * `createSentenceSplitter` cuts the stream up and `createSpeechQueue` plays
 * each piece while the next is still being synthesized, so the wait before the
 * first sound is one sentence rather than one whole answer.
 */

/**
 * Where the turn currently is, for the status line. Listening is not one of
 * these: the recorder owns that state, and duplicating it here would let the
 * two disagree when capture ends on its own.
 */
type Phase = "idle" | "transcribing" | "thinking" | "speaking";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Ready",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

const EMPTY_HINT =
  "Press the microphone and talk. Set a Hugging Face token in Settings (or point a custom provider at a local speech server) if the pickers show no options.";

export default function VoicePanel() {
  const [settings, setSettings] = useState<VoiceSettings>(loadVoiceSettings);
  const [llmProviders, setLlmProviders] = useState<ProviderInfo[]>([]);
  const [voiceProviders, setVoiceProviders] = useState<VoiceProviderInfo[]>([]);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const queueRef = useRef<SpeechQueue | null>(null);
  // The turn handler is created fresh per render but the recorder holds one
  // callback for the life of a recording; a ref keeps the settings it reads
  // current without restarting capture.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    void (async () => {
      try {
        const [llm, voice] = await Promise.all([listProviders(), listVoiceProviders()]);
        setLlmProviders(llm);
        setVoiceProviders(voice);
        setSettings((prev) => withVoiceDefaults(prev, llm, voice));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    saveVoiceSettings(settings);
  }, [settings]);

  const speechQueueFor = useCallback((current: VoiceSettings): SpeechQueue | null => {
    if (!current.speakReplies || !current.ttsProvider || !current.ttsModel) return null;
    return createSpeechQueue({
      synthesize: (text) =>
        speak({
          provider: current.ttsProvider,
          model: current.ttsModel,
          text,
          voice: current.ttsVoice || undefined,
        }),
      play: playAudioBlob,
      // One unspeakable chunk shouldn't silence the rest of the reply, so the
      // queue carries on and the failure is reported once, visibly.
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }, []);

  /** Runs one turn: transcript in, spoken reply out. */
  const handleUtterance = useCallback(
    async (audio: Blob) => {
      const current = settingsRef.current;
      setError(null);

      if (!current.sttProvider || !current.sttModel) {
        setError("choose a speech-to-text provider and model first");
        setPhase("idle");
        return;
      }
      if (!current.llmProvider || !current.llmModel) {
        setError("choose an answering model first");
        setPhase("idle");
        return;
      }

      let text: string;
      try {
        setPhase("transcribing");
        text = await transcribe({
          provider: current.sttProvider,
          model: current.sttModel,
          audio,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("idle");
        return;
      }

      if (!text.trim()) {
        // Silence or an unintelligible clip: nothing to ask the agent.
        setPhase("idle");
        return;
      }

      if (!sessionIdRef.current) {
        try {
          sessionIdRef.current = (await createSession("Voice")).id;
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("idle");
          return;
        }
      }

      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setPhase("thinking");

      const splitter = createSentenceSplitter();
      const queue = speechQueueFor(current);
      queueRef.current = queue;

      let reply = "";
      try {
        for await (const event of streamChat({
          sessionId: sessionIdRef.current,
          message: text,
          provider: current.llmProvider,
          model: current.llmModel,
        })) {
          if (event.type === "delta" && event.text) {
            reply += event.text;
            setStreaming(reply);
            for (const chunk of splitter.push(event.text)) queue?.push(chunk);
          } else if (event.type === "error") {
            setError(event.message ?? "stream error");
          }
        }
        for (const chunk of splitter.flush()) queue?.push(chunk);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }

      setStreaming("");
      if (reply) setMessages((prev) => [...prev, { role: "assistant", content: reply }]);

      if (queue) {
        setPhase("speaking");
        await queue.drain();
        queueRef.current = null;
      }
      setPhase("idle");
    },
    [speechQueueFor],
  );

  const recorder = useVoiceRecorder({
    onUtterance: (audio) => void handleUtterance(audio),
    autoStopSilenceMs: settings.handsFree ? undefined : null,
  });

  const busy = phase !== "idle";
  const { start: startRecording, recording, error: recorderError } = recorder;

  // Hands-free: re-open the mic once the spoken reply ends, so a conversation
  // continues without a click. Echo cancellation on the capture stream is what
  // keeps the assistant's own voice from being heard as the next question. A
  // failed start (no permission, no device) stops the cycle rather than
  // retrying the same failure on every render.
  useEffect(() => {
    if (!settings.handsFree || busy || recording || recorderError) return;
    if (messages.length === 0) return;
    void startRecording();
  }, [settings.handsFree, busy, recording, recorderError, messages.length, startRecording]);

  const stopEverything = useCallback(() => {
    recorder.stop();
    queueRef.current?.cancel();
    queueRef.current = null;
    setPhase("idle");
  }, [recorder]);

  const status = recording ? "Listening…" : PHASE_LABEL[phase];

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <VoiceSettingsBar
        settings={settings}
        onChange={setSettings}
        llmProviders={llmProviders}
        voiceProviders={voiceProviders}
      />

      <div className="flex-1 space-y-4 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <ChatMessages
          messages={messages}
          streaming={streaming}
          busy={phase === "thinking"}
          emptyHint={EMPTY_HINT}
        />
      </div>

      {(error || recorderError) && <p className="text-sm text-red-400">{error ?? recorderError}</p>}

      <div className="flex items-center gap-4">
        <MicButton
          recording={recording}
          level={recorder.level}
          disabled={busy}
          onStart={() => void startRecording()}
          onStop={() => recorder.stop()}
        />
        <div className="flex flex-col gap-1">
          <span className="text-sm text-zinc-300">{status}</span>
          <span className="text-xs text-zinc-500">
            {settings.handsFree ? "Turn ends on silence." : "Click again to send."}
          </span>
        </div>
        {(busy || recording) && (
          <button
            type="button"
            onClick={stopEverything}
            className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
