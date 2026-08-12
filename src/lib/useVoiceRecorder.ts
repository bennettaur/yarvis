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
const DEFAULT_SILENCE_MS = 1200;

/** Hard cap on one utterance, bounding both the upload and a stuck recorder. */
const MAX_UTTERANCE_MS = 60_000;

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
  stop: () => void;
}

export interface VoiceRecorderOptions {
  /** Receives the finished utterance. Not called for an empty recording. */
  onUtterance: (audio: Blob) => void;
  /** Silence that ends a turn; null keeps recording until `stop`. */
  autoStopSilenceMs?: number | null;
}

export function useVoiceRecorder({
  onUtterance,
  autoStopSilenceMs = DEFAULT_SILENCE_MS,
}: VoiceRecorderOptions): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  // Set before the `getUserMedia` await so a second `start` during that window
  // — the hands-free effect can fire again before `recording` flips — can't
  // open a second stream onto the same microphone.
  const startingRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Held in refs so the sampling loop, which is set up once per recording, always
  // sees the current handler and threshold rather than the ones it started with.
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const silenceMsRef = useRef(autoStopSilenceMs);
  silenceMsRef.current = autoStopSilenceMs;

  const teardown = useCallback(() => {
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

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    // `onstop` delivers the blob; teardown runs from there so the last data
    // event is not cut off.
    recorder.stop();
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (recorderRef.current || startingRef.current) return false;
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("this build has no microphone support");
      return false;
    }
    startingRef.current = true;

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
    streamRef.current = stream;

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;

    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(parts, { type: recorder.mimeType || mimeType || "audio/webm" });
      teardown();
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

    let heardSpeech = false;
    let silentMs = 0;
    let elapsedMs = 0;
    timerRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / samples.length);
      setLevel(rms);

      elapsedMs += LEVEL_INTERVAL_MS;
      if (elapsedMs >= MAX_UTTERANCE_MS) {
        stop();
        return;
      }

      const silenceMs = silenceMsRef.current;
      if (silenceMs === null) return;
      if (rms >= SPEECH_LEVEL) heardSpeech = true;
      silentMs = rms < SILENCE_LEVEL ? silentMs + LEVEL_INTERVAL_MS : 0;
      if (heardSpeech && silentMs >= silenceMs) stop();
    }, LEVEL_INTERVAL_MS);

    recorder.start(LEVEL_INTERVAL_MS);
    setRecording(true);
    return true;
  }, [stop, teardown]);

  // Releasing the microphone matters more than delivering a half-utterance, so
  // an unmount mid-recording drops it rather than stopping cleanly.
  useEffect(() => teardown, [teardown]);

  return { recording, level, error, start, stop };
}
