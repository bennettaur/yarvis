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
 * How long after a reply stops playing a new turn is still checked as its
 * echo. Covers the detector's own delay: it confirms speech only after
 * hearing some, and the audio reaches it over a websocket.
 */
const ECHO_TAIL_MS = 1500;

/**
 * Fewest words a turn starting after the reply ended needs to be dropped as
 * echo. That is when the user answers the reply's closing question, and a
 * short answer like "yes" often repeats one of its words.
 */
const ECHO_TAIL_MIN_WORDS = 3;

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
  /**
   * Whether the surface is on screen. Hiding it cancels everything in
   * progress: a continuous mic left open would send what it hears into a chat
   * nobody can see.
   */
  visible: boolean;
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

export function useVoice({
  send,
  streaming,
  busy,
  visible,
  io = REAL_IO,
}: UseVoiceOptions): UseVoiceResult {
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
  /** The reply text queued for speech so far, for spotting echo. */
  const spokenTextRef = useRef("");
  /** The reply text queued for speech when the user's current turn started; "" when none was. */
  const echoReferenceRef = useRef("");
  /** The user's current turn started after the reply ended, inside `ECHO_TAIL_MS`. */
  const echoTailRef = useRef(false);
  /** When the last reply finished playing, as `Date.now()`. */
  const playbackEndedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [levelMeter] = useState(createLevelMeter);
  /** The user has started continuous mode's microphone and not stopped it. */
  const [continuousArmed, setContinuousArmed] = useState(false);

  // A continuous turn goes through three steps:
  //  1. `transcribeInOrderRef` chains transcriptions one at a time, so a quick
  //     second turn can't be sent ahead of the first. A transcript that only
  //     repeats the reply it was heard over is dropped here as echo.
  //  2. A transcript is sent at once if the surface is free, or held in
  //     `heldTurns` while the agent replies or a send is still settling. A
  //     refused send is held too.
  //  3. Once the surface is free, held turns go out joined as one message, in
  //     one attempt: a refusal then drops them and says so.
  const transcribeInOrderRef = useRef<Promise<void>>(Promise.resolve());
  const [heldTurns, setHeldTurns] = useState<string[]>([]);
  // Mirrors `heldTurns`; update both together. Read when a transcript lands,
  // which can be before the flush effect below has run: a turn must not be
  // sent ahead of ones already held.
  const heldTurnsRef = useRef<string[]>([]);
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
      if (queueRef.current === queue) {
        queueRef.current = null;
        playbackEndedAtRef.current = Date.now();
      }
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
      const generation = turnGenerationRef.current;
      try {
        // Converted because backends disagree about compressed containers; see
        // `toSpeechWav`. The turn detector already sends WAV.
        const wav = await ioRef.current.toWav(recording);
        const text = await transcribeTurn(wav, generation);
        if (!text || generation !== turnGenerationRef.current) return;
        await sendRef.current(text, { source: "voice" });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [transcribeTurn],
  );

  /**
   * Sends a continuous-mode transcript without waiting for the reply: the
   * surface's send settles only once its reply ends, and turns spoken meanwhile
   * must be transcribed and held, not stuck behind it. `sending` stays true
   * until the send settles, which also covers the moment before `busy` flips.
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

  const holdTurn = useCallback((text: string) => {
    heldTurnsRef.current = [...heldTurnsRef.current, text];
    setHeldTurns(heldTurnsRef.current);
  }, []);

  // A refused turn was said before anything held while its send was in flight.
  const holdRefusedTurn = useCallback((text: string) => {
    heldTurnsRef.current = [text, ...heldTurnsRef.current];
    setHeldTurns(heldTurnsRef.current);
  }, []);

  const handleContinuousTurn = useCallback(
    (wav: Blob) => {
      const generation = turnGenerationRef.current;
      // Taken and cleared here, so one speech start's reference never applies
      // to a later turn.
      const echoReference = echoReferenceRef.current;
      const inTail = echoTailRef.current;
      echoReferenceRef.current = "";
      echoTailRef.current = false;
      transcribeInOrderRef.current = transcribeInOrderRef.current
        .then(async () => {
          const text = await transcribeTurn(wav, generation);
          if (!text || generation !== turnGenerationRef.current) return;
          const tooShortForTail = inTail && text.split(/\s+/).length < ECHO_TAIL_MIN_WORDS;
          if (echoReference && !tooShortForTail && looksLikeEcho(text, echoReference)) return;
          if (busyRef.current || sendingRef.current || heldTurnsRef.current.length) holdTurn(text);
          else sendContinuous(text, generation, holdRefusedTurn);
        })
        // A turn that fails must not break the chain, or every later turn is
        // silently skipped.
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [transcribeTurn, sendContinuous, holdTurn, holdRefusedTurn],
  );

  // Cutting in: the user talking over the reply means they want to be heard,
  // and a reply left playing would be picked up as part of their turn. A reply
  // still on its way is silenced too, even one that hasn't started speaking
  // yet, or the streaming effect would start speaking over the user.
  const handleSpeechStart = useCallback(() => {
    const playing = queueRef.current !== null;
    // Kept to recognise this turn as the reply's own echo once transcribed,
    // including a turn that starts just after the reply ends (`ECHO_TAIL_MS`).
    const justPlayed = Date.now() - playbackEndedAtRef.current < ECHO_TAIL_MS;
    echoReferenceRef.current = playing || justPlayed ? spokenTextRef.current : "";
    echoTailRef.current = !playing && justPlayed;
    if (busyRef.current || sendingRef.current) silencedRef.current = true;
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

  // Continuous mode feeds the meter through `onLevel`; push-to-talk's level is
  // recorder state, mirrored in here.
  useEffect(() => {
    if (!continuousListening.listening) levelMeter.set(recorder.level);
  }, [levelMeter, recorder.level, continuousListening.listening]);

  // A failed start or a dropped connection disarms the mic, so the next click
  // starts it again instead of re-setting a flag that is already on. An older
  // error of the hook's own is cleared, so it can't hide why the mic closed.
  useEffect(() => {
    if (!continuousListening.error) return;
    setContinuousArmed(false);
    setError(null);
  }, [continuousListening.error]);

  // Held turns go out together once the surface is free: they were said as one
  // follow-up, split only by pauses. A second refusal drops them.
  useEffect(() => {
    if (busy || sending || heldTurns.length === 0) return;
    // From the ref, not this render's state: a turn held since the render
    // must go out too, not be cleared unsent.
    const turns = heldTurnsRef.current;
    heldTurnsRef.current = [];
    setHeldTurns([]);
    sendContinuous(turns.join(" "), turnGenerationRef.current, () =>
      setError("couldn't send what you said; it's been dropped"),
    );
  }, [busy, sending, heldTurns, sendContinuous]);

  // The streaming effect lifts a barge-in's silence when the reply text clears,
  // but a turn that ends before any reply text never changes it. The next
  // reply must still be spoken.
  useEffect(() => {
    if (!busy && !sending) silencedRef.current = false;
  }, [busy, sending]);

  // A minimised window closes the mic too: nobody is watching what it sends.
  // Coming back waits for a click.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") setContinuousArmed(false);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

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
    // Without this, the reply's next token would start a fresh speech queue
    // and speak the whole reply again from the top.
    if (busyRef.current || sendingRef.current) silencedRef.current = true;
    setContinuousArmed(false);
    // Left alone when already empty: the surfaces call this from effects.
    if (heldTurnsRef.current.length) {
      heldTurnsRef.current = [];
      setHeldTurns([]);
    }
    stopRecording({ discard: true });
    endSpeech();
    setPhase("idle");
  }, [stopRecording, endSpeech]);

  useEffect(() => {
    if (!visible) cancel();
  }, [visible, cancel]);

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
