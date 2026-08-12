import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Microphone capture for the voice loop: one utterance in, one audio blob out.
 *
 * Recording ends either when the user stops it or, with auto-stop on, after a
 * stretch of silence that follows actual speech — so a hands-free turn doesn't
 * need a second click to send. Loudness is sampled from a WebAudio analyser
 * rather than from the recorded bytes, which stay opaque until the recorder
 * finishes.
 */

/** Sampling period for the level meter and the silence timer (ms). */
const LEVEL_INTERVAL_MS = 100;

/** RMS above which we consider the user to be speaking (0..1). */
const SPEECH_LEVEL = 0.04;

/** RMS below which we consider the line silent (0..1). */
const SILENCE_LEVEL = 0.02;

/** Silence after speech that ends the utterance, when auto-stop is on. */
export const DEFAULT_SILENCE_MS = 1200;

/** Hard cap on one utterance, bounding both the upload and a stuck recorder. */
export const MAX_UTTERANCE_MS = 60_000;

/** Recording containers in preference order; the first supported one wins. */
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export interface VoiceRecorder {
  recording: boolean;
  /** Recent loudness, 0..1, for a mic meter. */
  level: number;
  error: string | null;
  /** Opens the mic. Resolves false when it could not start, or was already open. */
  start: () => Promise<boolean>;
  /** Ends the recording. `discard` throws the audio away instead of sending it. */
  stop: (options?: { discard?: boolean }) => void;
}

export interface VoiceRecorderOptions {
  /** Receives the finished utterance. Not called for an empty recording. */
  onUtterance: (audio: Blob) => void;
  /** Silence that ends a turn; null keeps recording until `stop`. */
  autoStopSilenceMs?: number | null;
  /**
   * Longest one recording may run. Callers use the default; it is settable so a
   * test can reach the cap without waiting a real minute.
   */
  maxUtteranceMs?: number;
}

/** Why a recording ended, which decides whether its audio is worth sending. */
type EndReason = "user" | "silence" | "cap" | "discard";

export function useVoiceRecorder({
  onUtterance,
  autoStopSilenceMs = DEFAULT_SILENCE_MS,
  maxUtteranceMs = MAX_UTTERANCE_MS,
}: VoiceRecorderOptions): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set before the `getUserMedia` await so a second `start` during that window
  // — the hands-free effect can fire again before `recording` flips — can't
  // open a second stream onto the same microphone.
  const startingRef = useRef(false);
  /**
   * Bumped by every teardown. `start` captures it before awaiting permission
   * and re-checks after: an unmount during that await has nothing to tear down
   * yet, so without this the stream it was granted would stay open with no
   * component left to stop it — a live microphone and no recording indicator.
   */
  const generationRef = useRef(0);
  /** How the current recording ended, read by `onstop`. */
  const endReasonRef = useRef<EndReason>("user");

  // Held in refs so the sampling loop, which is set up once per recording, always
  // sees the current handler and threshold rather than the ones it started with.
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const silenceMsRef = useRef(autoStopSilenceMs);
  silenceMsRef.current = autoStopSilenceMs;
  const maxUtteranceMsRef = useRef(maxUtteranceMs);
  maxUtteranceMsRef.current = maxUtteranceMs;

  const teardown = useCallback(() => {
    generationRef.current++;
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
    startingRef.current = false;
    setLevel(0);
    setRecording(false);
  }, []);

  const endRecording = useCallback((reason: EndReason) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    endReasonRef.current = reason;
    // `onstop` delivers the blob; teardown runs from there so the last data
    // event is not cut off.
    recorder.stop();
  }, []);

  const stop = useCallback(
    (options: { discard?: boolean } = {}) => endRecording(options.discard ? "discard" : "user"),
    [endRecording],
  );

  const start = useCallback(async (): Promise<boolean> => {
    if (recorderRef.current || startingRef.current) return false;
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("this build has no microphone support");
      return false;
    }
    startingRef.current = true;
    const generation = generationRef.current;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      startingRef.current = false;
      setError(
        e instanceof Error ? `microphone unavailable: ${e.message}` : "microphone unavailable",
      );
      return false;
    }

    // Torn down while the permission prompt was up: release what we were just
    // granted rather than wiring it to a component that is gone.
    if (generation !== generationRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    streamRef.current = stream;

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    endReasonRef.current = "user";

    // Declared before the handlers that read them, since `onstop` consults
    // `heardSpeech` to decide whether the recording is worth sending.
    let heardSpeech = false;
    let silentMs = 0;
    let elapsedMs = 0;

    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(parts, { type: recorder.mimeType || mimeType || "audio/webm" });
      const reason = endReasonRef.current;
      const heard = heardSpeech;
      teardown();
      // The cap can fire in a room that was never quiet enough to auto-stop but
      // where nobody was talking to the assistant either. Sending that is a
      // minute of ambient audio uploaded to a third party for nothing, so an
      // utterance with no speech in it is only delivered when the user
      // themselves ended it.
      if (reason === "discard") return;
      if (reason !== "user" && !heard) return;
      if (blob.size > 0) onUtteranceRef.current(blob);
    };
    recorder.onerror = () => {
      setError("recording failed");
      teardown();
    };

    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);

    timerRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / samples.length);
      setLevel(rms);

      if (rms >= SPEECH_LEVEL) heardSpeech = true;

      elapsedMs += LEVEL_INTERVAL_MS;
      if (elapsedMs >= maxUtteranceMsRef.current) {
        endRecording("cap");
        return;
      }

      const silenceMs = silenceMsRef.current;
      if (silenceMs === null) return;
      silentMs = rms < SILENCE_LEVEL ? silentMs + LEVEL_INTERVAL_MS : 0;
      if (heardSpeech && silentMs >= silenceMs) endRecording("silence");
    }, LEVEL_INTERVAL_MS);

    recorder.start(LEVEL_INTERVAL_MS);
    setRecording(true);
    return true;
  }, [endRecording, teardown]);

  // Releasing the microphone matters more than delivering a half-utterance, so
  // an unmount mid-recording drops it rather than stopping cleanly.
  useEffect(() => teardown, [teardown]);

  return { recording, level, error, start, stop };
}
