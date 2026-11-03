import { useEffect, useRef, useState } from "react";
import type { TurnStream, TurnStreamHandlers } from "./turnStream";
import type { TurnDetectorStatus } from "./voice";

/** How often to ask whether a starting detector is ready yet. */
const POLL_MS = 1000;

export interface ContinuousIO {
  startDetector: () => Promise<TurnDetectorStatus>;
  detectorStatus: () => Promise<TurnDetectorStatus>;
  openStream: (url: string, handlers: TurnStreamHandlers) => Promise<TurnStream>;
}

export interface ContinuousListeningOptions {
  /** The microphone should be open. Turning it false closes it, even mid-start. */
  active: boolean;
  /** The user started talking. Fires once per turn, before its `onTurn`. */
  onSpeechStart: () => void;
  /** A finished turn, as 16 kHz WAV. */
  onTurn: (audio: Blob) => void;
  /** Microphone loudness, 0..1, about ten times a second; 0 once the mic closes. */
  onLevel: (level: number) => void;
  io: ContinuousIO;
}

export interface ContinuousListening {
  /** Waiting for the detector or the microphone. */
  starting: boolean;
  /** The microphone is open and streaming. */
  listening: boolean;
  /** The user is mid-turn, as the detector hears it. */
  hearing: boolean;
  error: string | null;
}

/**
 * Keeps the microphone streaming to the turn detector while `active` is true,
 * and reports each turn the detector hands back.
 *
 * The detector is a Python process the sidecar starts on first use. That first
 * start installs its packages and downloads two small models, so it can take a
 * minute; `starting` covers that wait.
 */
export function useContinuousListening({
  active,
  onSpeechStart,
  onTurn,
  onLevel,
  io,
}: ContinuousListeningOptions): ContinuousListening {
  const [starting, setStarting] = useState(false);
  const [listening, setListening] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in refs so the stream, opened once per activation, calls the current ones.
  const onSpeechStartRef = useRef(onSpeechStart);
  onSpeechStartRef.current = onSpeechStart;
  const onTurnRef = useRef(onTurn);
  onTurnRef.current = onTurn;
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;
  const ioRef = useRef(io);
  ioRef.current = io;

  useEffect(() => {
    if (!active) return;
    // Set by cleanup. Every await below re-checks it, so a deactivation during
    // the detector's start or the permission prompt never leaves a mic open.
    let cancelled = false;
    let stream: TurnStream | null = null;
    setError(null);
    setStarting(true);

    const fail = (message: string) => {
      if (cancelled) return;
      setError(message);
      setStarting(false);
      setListening(false);
      setHearing(false);
      onLevelRef.current(0);
    };

    void (async () => {
      try {
        let status = await ioRef.current.startDetector();
        while (!cancelled && status.state === "starting") {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          if (cancelled) return;
          status = await ioRef.current.detectorStatus();
        }
        if (cancelled) return;
        if (status.state !== "running" || !status.url) {
          const detail =
            status.error ?? status.log[status.log.length - 1] ?? `detector is ${status.state}`;
          fail(`turn detector didn't start: ${detail}`);
          return;
        }
        const opened = await ioRef.current.openStream(status.url, {
          onSpeechStart: () => {
            setHearing(true);
            onSpeechStartRef.current();
          },
          onTurn: (audio) => {
            setHearing(false);
            onTurnRef.current(audio);
          },
          onLevel: (rms) => onLevelRef.current(rms),
          onError: fail,
        });
        if (cancelled) {
          opened.close();
          return;
        }
        stream = opened;
        setStarting(false);
        setListening(true);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      stream?.close();
      setStarting(false);
      setListening(false);
      setHearing(false);
      onLevelRef.current(0);
    };
  }, [active]);

  return { starting, listening, hearing, error };
}
