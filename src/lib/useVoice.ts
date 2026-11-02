import { useCallback, useEffect, useRef, useState } from "react";
import { toSpeechWav } from "./audioEncoding";
import { playAudioBlob } from "./audioPlayback";
import { createSentenceSplitter, type SentenceSplitter } from "./speechChunks";
import { createSpeechQueue, type SpeechQueue } from "./speechQueue";
import { openTurnStream } from "./turnStream";
import { type ContinuousIO, useContinuousListening } from "./useContinuousListening";
import { useVoiceRecorder } from "./useVoiceRecorder";
import { getTurnDetector, speak, startTurnDetector, transcribe } from "./voice";
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
 *
 * In continuous mode the microphone stays open and the sidecar's turn detector
 * decides when each turn ends. A turn that finishes while the agent is still
 * replying is held and sent once the reply ends, since the surface refuses a
 * second turn while one runs. Starting to talk stops the reply being spoken,
 * so the user can cut in and the reply isn't transcribed as their turn.
 */

/**
 * Everything the loop reaches outside itself. Collected behind one option so a
 * test can drive the hook without stubbing the modules other tests assert on —
 * the same seam `fetchImpl` gives the sidecar's speech clients.
 */
export interface VoiceIO extends ContinuousIO {
  transcribe: typeof transcribe;
  speak: typeof speak;
  playAudio: (audio: Blob, signal: AbortSignal) => Promise<void>;
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
  startDetector: startTurnDetector,
  detectorStatus: getTurnDetector,
  openStream: openTurnStream,
};

export interface UseVoiceOptions {
  /**
   * The surface's own send. Marked as spoken so the agent gates its writes.
   * Returning `false` means the surface refused the turn, so it is held and
   * tried again when the current turn ends.
   */
  send: (text: string, options: { source: "voice" }) => unknown;
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
  /** The microphone is open, push-to-talk or continuous. */
  recording: boolean;
  /** Continuous mode is waiting on the turn detector or the microphone. */
  starting: boolean;
  /** Continuous mode hears the user mid-turn. */
  hearing: boolean;
  /** Finished turns waiting for the agent's current reply to end. */
  held: number;
  /** Microphone loudness, 0..1. */
  level: number;
  phase: VoicePhase;
  error: string | null;
  startListening: () => void;
  /** Push-to-talk: ends the recording and sends it. Continuous: closes the mic. */
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
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const queueRef = useRef<SpeechQueue | null>(null);
  const splitterRef = useRef<SentenceSplitter | null>(null);
  /** How much of `streaming` has already been handed to the splitter. */
  const spokenThroughRef = useRef(0);
  /** Set when the user cuts in, so the rest of that reply stays unspoken. */
  const silencedRef = useRef(false);
  /** Whether continuous mode's microphone should be open. */
  const [continuousOn, setContinuousOn] = useState(false);
  /** Transcripts of turns finished while the agent was busy, oldest first. */
  const [held, setHeld] = useState<string[]>([]);
  /**
   * Turns are transcribed one after another, so a quick second turn can't be
   * sent ahead of the first.
   */
  const turnChainRef = useRef<Promise<void>>(Promise.resolve());
  /** Bumped by cancel, so a transcription already in flight is dropped. */
  const turnGenerationRef = useRef(0);

  // Re-read as each turn starts, not only on mount: the Chat tab stays mounted,
  // and a voice activated or deleted on the Voice page must reach the next reply.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current && !busy) return;
    loadedRef.current = true;
    void (async () => {
      try {
        setConfig(await ioRef.current.loadConfig());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [busy]);

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
      silencedRef.current = false;
      return;
    }
    if (silencedRef.current) return;
    if (!splitterRef.current) {
      splitterRef.current = createSentenceSplitter();
      queueRef.current = createSpeechQueue({
        synthesize: (text) => ioRef.current.speak(speechRequestFor(configRef.current, text)),
        play: (audio, signal) => ioRef.current.playAudio(audio, signal),
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

  /** Transcribes one turn's audio. Answers null when there was nothing to send. */
  const transcribeTurn = useCallback(async (audio: Blob, wav: boolean): Promise<string | null> => {
    const current = configRef.current;
    if (!voiceReadiness(current).stt) {
      setError("choose a speech-to-text provider and model in Settings → Voice");
      return null;
    }
    setError(null);
    setPhase("transcribing");
    try {
      const text = await ioRef.current.transcribe({
        provider: current.sttProvider,
        model: current.sttModel,
        // Converted here because backends disagree about compressed
        // containers; see `toSpeechWav`. The turn detector already sends WAV.
        audio: wav ? audio : await ioRef.current.toWav(audio),
        language: current.sttLanguage || undefined,
      });
      return text.trim() || null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setPhase("idle");
    }
  }, []);

  const handleUtterance = useCallback(
    async (audio: Blob) => {
      const text = await transcribeTurn(audio, false);
      if (text) await sendRef.current(text, { source: "voice" });
    },
    [transcribeTurn],
  );

  const handleTurn = useCallback(
    (audio: Blob) => {
      const generation = turnGenerationRef.current;
      turnChainRef.current = turnChainRef.current.then(async () => {
        const text = await transcribeTurn(audio, true);
        if (!text || generation !== turnGenerationRef.current) return;
        if (busyRef.current) {
          setHeld((prev) => [...prev, text]);
          return;
        }
        const accepted = await sendRef.current(text, { source: "voice" });
        if (accepted === false && generation === turnGenerationRef.current) {
          setHeld((prev) => [...prev, text]);
        }
      });
    },
    [transcribeTurn],
  );

  // Cutting in: the user talking over the reply means they want to be heard,
  // and a reply left playing would be picked up as part of their turn.
  const handleSpeechStart = useCallback(() => {
    if (!queueRef.current) return;
    if (busyRef.current) silencedRef.current = true;
    endSpeech();
    setPhase("idle");
  }, [endSpeech]);

  const recorder = useVoiceRecorder({
    onUtterance: (audio) => void handleUtterance(audio),
  });
  const { start: startRecording, stop: stopRecording } = recorder;

  const continuous = useContinuousListening({
    active: continuousOn && config.continuous,
    onSpeechStart: handleSpeechStart,
    onTurn: (audio) => handleTurn(audio),
    io,
  });

  // Turns held during a reply go out together once it ends: they were said as
  // one follow-up, split only by pauses.
  useEffect(() => {
    if (busy || held.length === 0) return;
    const text = held.join(" ");
    setHeld([]);
    const generation = turnGenerationRef.current;
    void (async () => {
      const accepted = await sendRef.current(text, { source: "voice" });
      if (accepted === false && generation === turnGenerationRef.current) {
        setError("couldn't send what you said; it's been dropped");
      }
    })();
  }, [busy, held]);

  // Turning the mode off closes the mic, and turning it back on waits for a click.
  useEffect(() => {
    if (!config.continuous) setContinuousOn(false);
  }, [config.continuous]);

  const startListening = useCallback(() => {
    if (configRef.current.continuous) setContinuousOn(true);
    else void startRecording();
  }, [startRecording]);

  const stopListening = useCallback(() => {
    setContinuousOn(false);
    stopRecording();
  }, [stopRecording]);

  const cancel = useCallback(() => {
    turnGenerationRef.current++;
    setContinuousOn(false);
    setHeld([]);
    stopRecording({ discard: true });
    endSpeech();
    setPhase("idle");
  }, [stopRecording, endSpeech]);

  // Speech that outlives the surface would keep playing with nothing to stop it.
  useEffect(() => endSpeech, [endSpeech]);

  return {
    config,
    updateConfig,
    ready: voiceReadiness(config),
    recording: recorder.recording || continuous.listening,
    starting: continuous.starting,
    hearing: continuous.hearing,
    held: held.length,
    level: continuous.listening ? continuous.level : recorder.level,
    phase,
    error: error ?? recorder.error ?? continuous.error,
    startListening,
    stopListening,
    cancel,
  };
}
