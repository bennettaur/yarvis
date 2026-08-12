import { useCallback, useEffect, useRef, useState } from "react";
import { toSpeechWav } from "../lib/audioEncoding";
import { playAudioBlob } from "../lib/audioPlayback";
import {
  createSession,
  listProviders,
  type PendingApproval,
  type ProviderInfo,
  respondToToolApproval,
  streamChat,
  type ThreadMessage,
} from "../lib/chat";
import { createSentenceSplitter } from "../lib/speechChunks";
import { createSpeechQueue, type SpeechQueue } from "../lib/speechQueue";
import { DEFAULT_SILENCE_MS, useVoiceRecorder } from "../lib/useVoiceRecorder";
import { listVoiceProviders, speak, transcribe, type VoiceProviderInfo } from "../lib/voice";
import {
  loadVoiceSettings,
  saveVoiceSettings,
  type VoiceSettings,
  withVoiceDefaults,
} from "../lib/voiceSettings";
import ChatMessages from "./ChatMessages";
import { ToolApprovalPrompt } from "./ToolApprovalPrompt";
import MicButton from "./voice/MicButton";
import VoiceSettingsBar from "./voice/VoiceSettingsBar";

/**
 * The voice loop: speak, get transcribed, have the agent answer, hear it back.
 *
 * It drives the same chat agent as the Chat tab (same tools, same memory)
 * through the existing stream, and only adds the two speech hops around it.
 * Those hops are deliberately per-sentence rather than per-reply —
 * `createSentenceSplitter` cuts the stream up and `createSpeechQueue` plays
 * each piece while the next is still being synthesized, so the wait before the
 * first sound is one sentence rather than one whole answer.
 *
 * Turns are marked as spoken on the way out, which is what puts the agent's
 * irreversible tools behind a confirmation prompt here — see
 * `sidecar/src/chat/destructiveTools.ts`.
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
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

  const sessionIdRef = useRef<string | null>(null);
  const queueRef = useRef<SpeechQueue | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Whether hands-free may re-open the mic. Cleared when the user stops a turn,
   * so "Stop" means stopped rather than "pause until the next render" — the
   * effect below would otherwise see an idle phase and immediately start
   * listening again, on top of the turn being torn down.
   */
  const handsFreeArmedRef = useRef(false);
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

  const createSpeechQueueFor = useCallback((current: VoiceSettings): SpeechQueue | null => {
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

  const respondApproval = useCallback(async (id: string, approved: boolean) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
    try {
      await respondToToolApproval(id, approved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** Ends the turn: nothing further is spoken, and the model stops generating. */
  const endTurn = useCallback(() => {
    handsFreeArmedRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    queueRef.current?.cancel();
    queueRef.current = null;
    setApprovals([]);
    setStreaming("");
    setPhase("idle");
  }, []);

  /** Runs one turn: transcript in, spoken reply out. */
  const handleUtterance = useCallback(
    async (audio: Blob) => {
      const current = settingsRef.current;
      setError(null);

      const fail = (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase("idle");
      };

      if (!current.sttProvider || !current.sttModel) {
        fail("choose a speech-to-text provider and model first");
        return;
      }
      if (!current.llmProvider || !current.llmModel) {
        fail("choose an answering model first");
        return;
      }

      let text: string;
      try {
        setPhase("transcribing");
        // Converted here rather than sent as recorded: the browser only encodes
        // compressed containers, and not every backend can decode them (Ollama
        // takes WAV and refuses AAC). See `toSpeechWav`.
        text = await transcribe({
          provider: current.sttProvider,
          model: current.sttModel,
          audio: await toSpeechWav(audio),
          language: current.sttLanguage || undefined,
        });
      } catch (e) {
        fail(e);
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
          fail(e);
          return;
        }
      }

      setMessages((prev) => [
        ...prev,
        { role: "user", content: text, metadata: { source: "voice" } },
      ]);
      setPhase("thinking");

      const splitter = createSentenceSplitter();
      const queue = createSpeechQueueFor(current);
      queueRef.current = queue;
      const abort = new AbortController();
      abortRef.current = abort;

      let reply = "";
      try {
        for await (const event of streamChat(
          {
            sessionId: sessionIdRef.current,
            message: text,
            provider: current.llmProvider,
            model: current.llmModel,
            // Marks this as a turn the user spoke, which gates the agent's
            // destructive tools behind the approval prompt below.
            source: "voice",
          },
          { signal: abort.signal },
        )) {
          if (event.type === "delta" && event.text) {
            reply += event.text;
            setStreaming(reply);
            for (const chunk of splitter.push(event.text)) queue?.push(chunk);
          } else if (event.type === "tool_approval_request" && event.id) {
            const id = event.id;
            const name = event.name ?? id;
            setApprovals((prev) => [
              ...prev,
              { id, name, server: event.server ?? "", args: event.args },
            ]);
            // Hands-free means the user may not be looking at the screen, so
            // the prompt is announced as well as shown. Answering is still a
            // click: a spoken "confirm" would be one more thing the recognizer
            // could mishear, on exactly the operations where that matters most.
            queue?.push(`${name} needs your approval.`);
          } else if (event.type === "error") {
            setError(event.message ?? "stream error");
          }
        }
        for (const chunk of splitter.flush()) queue?.push(chunk);
      } catch (e) {
        // An abort is the user pressing Stop, not a failure to report.
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }

      if (abort.signal.aborted) return;
      abortRef.current = null;

      setStreaming("");
      if (reply) setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      // Any approval not answered by the time the turn ends is moot.
      setApprovals([]);

      if (queue) {
        setPhase("speaking");
        await queue.drain();
        queueRef.current = null;
      }
      setPhase("idle");
    },
    [createSpeechQueueFor],
  );

  const recorder = useVoiceRecorder({
    onUtterance: (audio) => void handleUtterance(audio),
    autoStopSilenceMs: settings.handsFree ? DEFAULT_SILENCE_MS : null,
  });

  const busy = phase !== "idle";
  const { start: startRecording, stop: stopRecording, recording, error: recorderError } = recorder;

  const startListening = useCallback(() => {
    handsFreeArmedRef.current = true;
    void startRecording();
  }, [startRecording]);

  // Hands-free: re-open the mic once the spoken reply ends, so a conversation
  // continues without a click. Echo cancellation on the capture stream is what
  // keeps the assistant's own voice from being heard as the next question. It
  // waits for a first turn so the mic never opens by itself on arrival — the
  // conversation is always something the user started — and a failed start (no
  // permission, no device) ends the cycle rather than retrying every render.
  useEffect(() => {
    if (!settings.handsFree || !handsFreeArmedRef.current) return;
    if (busy || recording || recorderError) return;
    if (messages.length === 0) return;
    void startRecording();
  }, [settings.handsFree, busy, recording, recorderError, messages.length, startRecording]);

  /** The Stop button: end the turn and throw away whatever was being recorded. */
  const stopEverything = useCallback(() => {
    stopRecording({ discard: true });
    endTurn();
  }, [stopRecording, endTurn]);

  // Leaving the tab unmounts this panel, so without this the reply would keep
  // playing with no visible surface to stop it and the model would keep
  // generating for a reader that no longer exists.
  useEffect(() => endTurn, [endTurn]);

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
        {approvals.map((a) => (
          <ToolApprovalPrompt
            key={a.id}
            approval={a}
            onRespond={(approved) => void respondApproval(a.id, approved)}
          />
        ))}
      </div>

      {(error || recorderError) && <p className="text-sm text-red-400">{error ?? recorderError}</p>}

      <div className="flex items-center gap-4">
        <MicButton
          recording={recording}
          level={recorder.level}
          disabled={busy}
          onStart={startListening}
          onStop={() => stopRecording()}
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
