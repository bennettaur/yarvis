import { encodeWav, SPEECH_SAMPLE_RATE } from "./audioEncoding";

/**
 * Streams the microphone to the sidecar's turn detector for continuous voice
 * mode, and hands back each finished turn as 16 kHz WAV ready to transcribe.
 *
 * The detector does the listening: Silero VAD hears speech start and pause,
 * and smart-turn decides whether a pause ends the turn. This side only
 * captures, resamples to 16 kHz int16, and turns the replies into callbacks.
 */

/** Why the detector ended a turn: smart-turn judged it complete, a long silence, or the length cap. */
export type TurnEndReason = "complete" | "silence" | "cap";

export interface TurnStreamHandlers {
  /** The user started talking. Fires once per turn. */
  onSpeechStart: () => void;
  onTurn: (audio: Blob, reason: TurnEndReason) => void;
  /** Microphone loudness, 0..1, about ten times a second. */
  onLevel: (level: number) => void;
  /** The stream failed and has closed itself. */
  onError: (message: string) => void;
}

export interface TurnStream {
  /** Drops the turn in progress, keeping the stream open. */
  reset: () => void;
  close: () => void;
}

const LEVEL_INTERVAL_MS = 100;

/** A resampler that carries its position across chunks, so a stream has no seams. */
export function createResampler(from: number, to: number): (input: Float32Array) => Float32Array {
  const step = from / to;
  // Position of the next output sample, relative to the start of `input`.
  // Negative means it falls between the previous chunk's last sample and this
  // chunk's first one.
  let position = 0;
  let previous = 0;
  return (input) => {
    const out: number[] = [];
    while (position < input.length - 1) {
      const index = Math.floor(position);
      const weight = position - index;
      const left = index < 0 ? previous : input[index]!;
      const right = input[index + 1]!;
      out.push(left * (1 - weight) + right * weight);
      position += step;
    }
    if (input.length > 0) previous = input[input.length - 1]!;
    position -= input.length;
    return Float32Array.from(out);
  };
}

export function toInt16(samples: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

function int16ToWav(pcm: ArrayBuffer): Blob {
  const samples = new Int16Array(pcm);
  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i]! / 0x8000;
  return encodeWav(floats, SPEECH_SAMPLE_RATE);
}

/**
 * Turns the detector's messages into handler calls. A `turn` event is always
 * followed by one binary message holding that turn's audio.
 */
export function createTurnMessageHandler(
  handlers: Pick<TurnStreamHandlers, "onSpeechStart" | "onTurn">,
): (data: string | ArrayBuffer) => void {
  let pendingReason: TurnEndReason | null = null;
  return (data) => {
    if (typeof data !== "string") {
      if (pendingReason) handlers.onTurn(int16ToWav(data), pendingReason);
      pendingReason = null;
      return;
    }
    const event = JSON.parse(data) as { type: string; reason?: TurnEndReason };
    if (event.type === "speech_start") handlers.onSpeechStart();
    else if (event.type === "turn") pendingReason = event.reason ?? "complete";
  };
}

/** Opens the microphone and the detector's websocket. Rejects when either can't start. */
export async function openTurnStream(
  url: string,
  handlers: TurnStreamHandlers,
): Promise<TurnStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("this build has no microphone support");
  }

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("could not reach the turn detector"));
  });

  let stream: MediaStream;
  try {
    // Echo cancellation matters more here than for push-to-talk: the mic stays
    // open while replies play, and without it the reply hears itself.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    socket.close();
    throw new Error(
      e instanceof Error ? `microphone unavailable: ${e.message}` : "microphone unavailable",
    );
  }

  const context = new AudioContext();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const track of stream.getTracks()) track.stop();
    context.close().catch(() => {});
    socket.onclose = null;
    socket.close();
  };

  try {
    // Imported here rather than at the top so bun's test runner, which has no
    // `?url` loader, can still import this module's pure helpers.
    const { default: workletUrl } = await import("./pcmCaptureWorklet.js?url");
    await context.audioWorklet.addModule(workletUrl);
  } catch (e) {
    close();
    throw new Error(`could not start audio capture: ${e instanceof Error ? e.message : e}`);
  }

  const source = context.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(context, "pcm-capture");
  // A node with no path to the output may never be processed, so route it
  // through a muted gain rather than leaving it dangling.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(capture).connect(mute).connect(context.destination);

  const resample = createResampler(context.sampleRate, SPEECH_SAMPLE_RATE);
  let levelSum = 0;
  let levelCount = 0;
  let lastLevelAt = 0;
  capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const samples = event.data;
    for (const sample of samples) levelSum += sample * sample;
    levelCount += samples.length;
    const now = performance.now();
    if (now - lastLevelAt >= LEVEL_INTERVAL_MS) {
      handlers.onLevel(Math.sqrt(levelSum / Math.max(1, levelCount)));
      levelSum = 0;
      levelCount = 0;
      lastLevelAt = now;
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(toInt16(resample(samples)));
  };

  const onMessage = createTurnMessageHandler(handlers);
  socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => onMessage(event.data);
  socket.onclose = () => {
    close();
    handlers.onError("lost the connection to the turn detector");
  };

  return {
    reset: () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "reset" }));
    },
    close,
  };
}
