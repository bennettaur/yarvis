import { useCallback, useEffect, useRef, useState } from "react";
import { toSpeechWav } from "./audioEncoding";
import { playAudioBlob } from "./audioPlayback";
import { createSentenceSplitter, type SentenceSplitter } from "./speechChunks";
import { createSpeechQueue, type SpeechQueue } from "./speechQueue";
import { DEFAULT_SILENCE_MS, useVoiceRecorder } from "./useVoiceRecorder";
import { speak, transcribe } from "./voice";
import {
  DEFAULT_VOICE_CONFIG,
  getVoiceConfig,
  saveVoiceConfig,
  speechRequestFor,
  type VoiceConfig,
  voiceReadiness,
} from "./voiceConfig";

/**
 * Speech around an existing chat thread: talk instead of typing, and hear the
 * reply as it streams.
 *
 * This deliberately does not own the conversation. It takes the surface's own
 * `send` and watches the reply text the surface is already accumulating, so the
 * Chat tab and Omni Chat each keep their own session, provider and model — a
 * spoken turn goes to whatever model that surface is set to, rather than to a
 * second one configured elsewhere.
 *
 * Replies are spoken a sentence at a time as they arrive, so speech starts
 * about a sentence behind the model instead of a whole answer behind it.
 */

/**
 * Everything the loop reaches outside itself. Collected behind one option so a
 * test can drive the hook without stubbing the modules other tests assert on —
 * the same seam `fetchImpl` gives the sidecar's speech clients.
 */
export interface VoiceIO {
  transcribe: typeof transcribe;
  speak: typeof speak;
  playAudio: (audio: Blob) => Promise<void>;
  toWav: (recording: Blob) => Promise<Blob>;
  loadConfig: () => Promise<VoiceConfig>;
  saveConfig: (patch: Partial<VoiceConfig>) => Promise<VoiceConfig>;
}

const REAL_IO: VoiceIO = {
  transcribe,
  speak,
  playAudio: playAudioBlob,
  toWav: toSpeechWav,
  loadConfig: getVoiceConfig,
  saveConfig: saveVoiceConfig,
};

export interface UseVoiceOptions {
  /** The surface's own send. Marked as spoken so the agent gates its writes. */
  send: (text: string, options: { source: "voice" }) => void | Promise<void>;
  /** Reply text accumulating for the current turn; "" between turns. */
  streaming: string;
  /** Whether a turn is in flight on the surface. */
  busy: boolean;
  io?: VoiceIO;
}

/** Where a spoken turn is, for the status line. */
export type VoicePhase = "idle" | "transcribing" | "speaking";

export interface UseVoiceResult {
  config: VoiceConfig;
  /** Persists a change and applies it locally; used by the two toggles. */
  updateConfig: (patch: Partial<VoiceConfig>) => Promise<void>;
  ready: { stt: boolean; tts: boolean };
  recording: boolean;
  /** Microphone loudness, 0..1. */
  level: number;
  phase: VoicePhase;
  error: string | null;
  startListening: () => void;
  /** Ends the recording and sends it. */
  stopListening: () => void;
  /** Abandons the turn: drops the recording and silences queued speech. */
  cancel: () => void;
}

export function useVoice({ send, streaming, busy, io = REAL_IO }: UseVoiceOptions): UseVoiceResult {
  const [config, setConfig] = useState<VoiceConfig>(DEFAULT_VOICE_CONFIG);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const configRef = useRef(config);
  configRef.current = config;
  const sendRef = useRef(send);
  sendRef.current = send;
  const ioRef = useRef(io);
  ioRef.current = io;

  const queueRef = useRef<SpeechQueue | null>(null);
  const splitterRef = useRef<SentenceSplitter | null>(null);
  /** How much of `streaming` has already been handed to the splitter. */
  const spokenThroughRef = useRef(0);
  /**
   * Whether hands-free may re-open the mic. Cleared on cancel, so stopping a
   * turn means stopped rather than "paused until the next render".
   */
  const armedRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        setConfig(await ioRef.current.loadConfig());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const updateConfig = useCallback(async (patch: Partial<VoiceConfig>) => {
    // Applied locally first: a toggle that waits for a round trip feels broken.
    setConfig((prev) => ({ ...prev, ...patch }));
    try {
      setConfig(await ioRef.current.saveConfig(patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const endSpeech = useCallback(() => {
    queueRef.current?.cancel();
    queueRef.current = null;
    splitterRef.current = null;
    spokenThroughRef.current = 0;
  }, []);

  /** Speaks the text that has arrived since the last time this ran. */
  useEffect(() => {
    const current = configRef.current;
    if (!current.speakReplies || !voiceReadiness(current).tts) return;
    if (!streaming) {
      spokenThroughRef.current = 0;
      return;
    }
    if (!splitterRef.current) {
      splitterRef.current = createSentenceSplitter();
      queueRef.current = createSpeechQueue({
        synthesize: (text) => ioRef.current.speak(speechRequestFor(configRef.current, text)),
        play: (audio) => ioRef.current.playAudio(audio),
        // One unspeakable sentence shouldn't silence the rest of the reply.
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      });
    }
    // A shorter or diverging string means a new turn replaced the old text.
    if (!streaming.startsWith(streaming.slice(0, spokenThroughRef.current))) {
      spokenThroughRef.current = 0;
    }
    const delta = streaming.slice(spokenThroughRef.current);
    spokenThroughRef.current = streaming.length;
    if (delta) {
      for (const chunk of splitterRef.current.push(delta)) queueRef.current?.push(chunk);
    }
  }, [streaming]);

  /** Flushes the tail of the reply once the turn ends, then waits for playback. */
  useEffect(() => {
    if (busy) return;
    const splitter = splitterRef.current;
    const queue = queueRef.current;
    if (!splitter || !queue) return;

    for (const chunk of splitter.flush()) queue.push(chunk);
    splitterRef.current = null;
    spokenThroughRef.current = 0;
    setPhase("speaking");
    void queue.drain().then(() => {
      if (queueRef.current === queue) queueRef.current = null;
      setPhase("idle");
    });
  }, [busy]);

  const handleUtterance = useCallback(async (audio: Blob) => {
    const current = configRef.current;
    if (!voiceReadiness(current).stt) {
      setError("choose a speech-to-text provider and model in Settings → Voice");
      return;
    }
    setError(null);
    setPhase("transcribing");
    try {
      const text = await ioRef.current.transcribe({
        provider: current.sttProvider,
        model: current.sttModel,
        // Converted here because backends disagree about compressed
        // containers; see `toSpeechWav`.
        audio: await ioRef.current.toWav(audio),
        language: current.sttLanguage || undefined,
      });
      setPhase("idle");
      if (text.trim()) await sendRef.current(text, { source: "voice" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }, []);

  const recorder = useVoiceRecorder({
    onUtterance: (audio) => void handleUtterance(audio),
    autoStopSilenceMs: config.handsFree ? DEFAULT_SILENCE_MS : null,
  });
  const { start: startRecording, stop: stopRecording, recording, error: recorderError } = recorder;

  const startListening = useCallback(() => {
    armedRef.current = true;
    void startRecording();
  }, [startRecording]);

  const stopListening = useCallback(() => stopRecording(), [stopRecording]);

  const cancel = useCallback(() => {
    armedRef.current = false;
    stopRecording({ discard: true });
    endSpeech();
    setPhase("idle");
  }, [stopRecording, endSpeech]);

  // Hands-free: re-open the mic once the reply has finished being spoken, so a
  // back-and-forth needs no clicking. It waits for the user to have started
  // things once, and a failed start ends the cycle rather than retrying on
  // every render.
  useEffect(() => {
    if (!config.handsFree || !armedRef.current) return;
    if (busy || recording || recorderError) return;
    if (phase !== "idle") return;
    void startRecording();
  }, [config.handsFree, busy, recording, recorderError, phase, startRecording]);

  // Speech that outlives the surface would keep playing with nothing to stop it.
  useEffect(() => endSpeech, [endSpeech]);

  return {
    config,
    updateConfig,
    ready: voiceReadiness(config),
    recording,
    level: recorder.level,
    phase,
    error: error ?? recorderError,
    startListening,
    stopListening,
    cancel,
  };
}
