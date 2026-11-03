import { useCallback, useEffect, useRef, useState } from "react";
import { toSpeechWav } from "./audioEncoding";
import { playAudioBlob } from "./audioPlayback";
import { looksLikeEcho } from "./echoFilter";
import { createLevelMeter, type LevelMeter } from "./levelMeter";
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
 * so the user can cut in and the reply isn't transcribed as their turn. A turn
 * that starts over the reply and only repeats its words is the reply leaking
 * past echo cancellation, and is dropped.
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
   * retried once when the surface is free. A surface's send may only settle
   * once the reply has finished, so continuous mode doesn't wait on it.
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
  queued: number;
  /** Microphone loudness, 0..1. Read it with `useLevel` in the component that draws it. */
  level: LevelMeter;
  phase: VoicePhase;
  error: string | null;
  startListening: () => void;
  /** Push-to-talk: ends the recording and sends it. Continuous: closes the mic. */
  stopListening: () => void;
  /**
   * Abandons everything in progress: drops the recording, any transcription
   * still running, and held turns, silences queued speech, and closes
   * continuous mode's microphone.
   */
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
  /** The text handed to the current speech queue, for spotting echo. */
  const spokenTextRef = useRef("");
  /** What was playing when the user's current turn started; "" when nothing was. */
  const echoReferenceRef = useRef("");
  const [levelMeter] = useState(createLevelMeter);
  /** The user has started continuous mode's microphone and not stopped it. */
  const [continuousArmed, setContinuousArmed] = useState(false);

  // A continuous turn goes through three steps:
  //  1. `transcribeInOrder` transcribes turns one at a time, so a quick second
  //     turn can't be sent ahead of the first.
  //  2. A transcript is sent at once if the surface is free, or held in
  //     `heldTurns` while the agent replies or a send is still settling.
  //  3. Once the surface is free, held turns go out joined as one message. A
  //     refused send is held and retried once, then reported as dropped.
  const transcribeInOrderRef = useRef<Promise<void>>(Promise.resolve());
  const [heldTurns, setHeldTurns] = useState<string[]>([]);
  /** A continuous turn has been sent and its send hasn't settled yet. */
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
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

  const speakChunk = useCallback((chunk: string) => {
    spokenTextRef.current += ` ${chunk}`;
    queueRef.current?.push(chunk);
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
      // The last reply's tail may still be playing; the new reply replaces it,
      // or both would talk at once and only the new one could be stopped.
      queueRef.current?.cancel();
      spokenTextRef.current = "";
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
      for (const chunk of splitterRef.current.push(delta)) speakChunk(chunk);
    }
  }, [streaming, speakChunk]);

  /** Flushes the tail of the reply once the turn ends, then waits for playback. */
  useEffect(() => {
    if (busy) return;
    const splitter = splitterRef.current;
    const queue = queueRef.current;
    if (!splitter || !queue) return;

    for (const chunk of splitter.flush()) speakChunk(chunk);
    splitterRef.current = null;
    spokenThroughRef.current = 0;
    setPhase("speaking");
    void queue.drain().then(() => {
      if (queueRef.current === queue) queueRef.current = null;
      setPhase("idle");
    });
  }, [busy, speakChunk]);

  /**
   * Transcribes one turn's WAV audio. Answers null when there was nothing to
   * send. A turn the user cancelled in the meantime isn't transcribed at all.
   */
  const transcribeTurn = useCallback(async (wav: Blob, generation: number) => {
    const current = configRef.current;
    if (generation !== turnGenerationRef.current) return null;
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
        audio: wav,
        language: current.sttLanguage || undefined,
      });
      return text.trim() || null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      // A reply may have started speaking meanwhile; that label stays.
      setPhase((p) => (p === "transcribing" ? "idle" : p));
    }
  }, []);

  const sendPushToTalkUtterance = useCallback(
    async (recording: Blob) => {
      // Converted because backends disagree about compressed containers; see
      // `toSpeechWav`. The turn detector already sends WAV.
      const wav = await ioRef.current.toWav(recording);
      const text = await transcribeTurn(wav, turnGenerationRef.current);
      if (text) await sendRef.current(text, { source: "voice" });
    },
    [transcribeTurn],
  );

  /**
   * Sends a continuous-mode transcript without waiting for the reply: the
   * surface's send settles only once its reply ends, and turns spoken meanwhile
   * must be transcribed and held, not stuck behind it. `sending` covers the gap
   * before the surface reports itself busy.
   */
  const sendContinuous = useCallback(
    (text: string, generation: number, onRefused: (text: string) => void) => {
      sendingRef.current = true;
      setSending(true);
      void (async () => {
        try {
          const accepted = await sendRef.current(text, { source: "voice" });
          if (accepted === false && generation === turnGenerationRef.current) onRefused(text);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
      })();
    },
    [],
  );

  const holdTurn = useCallback((text: string) => setHeldTurns((prev) => [...prev, text]), []);

  const handleContinuousTurn = useCallback(
    (wav: Blob) => {
      const generation = turnGenerationRef.current;
      const echoReference = echoReferenceRef.current;
      echoReferenceRef.current = "";
      transcribeInOrderRef.current = transcribeInOrderRef.current
        .then(async () => {
          const text = await transcribeTurn(wav, generation);
          if (!text || generation !== turnGenerationRef.current) return;
          if (echoReference && looksLikeEcho(text, echoReference)) return;
          if (busyRef.current || sendingRef.current) holdTurn(text);
          else sendContinuous(text, generation, holdTurn);
        })
        // A turn that fails must not break the chain, or every later turn is
        // silently skipped.
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [transcribeTurn, sendContinuous, holdTurn],
  );

  // Cutting in: the user talking over the reply means they want to be heard,
  // and a reply left playing would be picked up as part of their turn. While
  // the reply is still on its way, its later sentences are silenced too, or the
  // streaming effect would start speaking over the user.
  const handleSpeechStart = useCallback(() => {
    const playing = queueRef.current !== null;
    // Kept to recognise this turn as the reply's own echo once transcribed.
    echoReferenceRef.current = playing ? spokenTextRef.current : "";
    if (busyRef.current) silencedRef.current = true;
    if (!playing) return;
    endSpeech();
    setPhase("idle");
  }, [endSpeech]);

  const recorder = useVoiceRecorder({
    onUtterance: (recording) => void sendPushToTalkUtterance(recording),
  });
  const { start: startRecording, stop: stopRecording } = recorder;

  const continuousListening = useContinuousListening({
    active: continuousArmed && config.continuous,
    onSpeechStart: handleSpeechStart,
    onTurn: handleContinuousTurn,
    onLevel: levelMeter.set,
    io,
  });

  useEffect(() => {
    if (!continuousListening.listening) levelMeter.set(recorder.level);
  }, [levelMeter, recorder.level, continuousListening.listening]);

  // A failed start or a dropped connection disarms the mic, so the next click
  // starts it again instead of re-setting a flag that is already on.
  useEffect(() => {
    if (continuousListening.error) setContinuousArmed(false);
  }, [continuousListening.error]);

  // Held turns go out together once the surface is free: they were said as one
  // follow-up, split only by pauses. A second refusal drops them.
  useEffect(() => {
    if (busy || sending || heldTurns.length === 0) return;
    setHeldTurns([]);
    sendContinuous(heldTurns.join(" "), turnGenerationRef.current, () =>
      setError("couldn't send what you said; it's been dropped"),
    );
  }, [busy, sending, heldTurns, sendContinuous]);

  // Turning the mode off closes the mic, and turning it back on waits for a click.
  useEffect(() => {
    if (!config.continuous) setContinuousArmed(false);
  }, [config.continuous]);

  const startListening = useCallback(() => {
    if (configRef.current.continuous) setContinuousArmed(true);
    else void startRecording();
  }, [startRecording]);

  const stopListening = useCallback(() => {
    setContinuousArmed(false);
    stopRecording();
  }, [stopRecording]);

  const cancel = useCallback(() => {
    turnGenerationRef.current++;
    setContinuousArmed(false);
    // Left alone when already empty: the surfaces call this from effects.
    setHeldTurns((prev) => (prev.length ? [] : prev));
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
    recording: recorder.recording || continuousListening.listening,
    starting: continuousListening.starting,
    hearing: continuousListening.hearing,
    queued: heldTurns.length,
    level: levelMeter,
    phase,
    error: error ?? recorder.error ?? continuousListening.error,
    startListening,
    stopListening,
    cancel,
  };
}
