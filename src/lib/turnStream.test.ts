import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createResampler,
  createTurnMessageHandler,
  openTurnStream,
  type TurnStreamHandlers,
  toInt16,
} from "./turnStream";

function ramp(length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => i / length);
}

/** The roughest signal there is: every sample the opposite of the last. */
function alternating(length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => (i % 2 === 0 ? 1 : -1));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fails a promise that never settles, rather than leaving the test runner waiting on it. */
function settlesSoon<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("still pending after 500 ms")), 500),
    ),
  ]);
}

async function wavSamples(wav: Blob): Promise<number[]> {
  const view = new DataView(await wav.arrayBuffer());
  const samples: number[] = [];
  for (let offset = 44; offset < view.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}

describe("createResampler", () => {
  it("turns 48 kHz into a third as many samples", () => {
    const out = createResampler(48_000, 16_000)(ramp(4800));
    expect(out.length).toBeGreaterThanOrEqual(1599);
    expect(out.length).toBeLessThanOrEqual(1600);
  });

  it("keeps every other sample when halving the rate", () => {
    const input = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from(createResampler(32_000, 16_000)(input))).toEqual([0, 2, 4, 6]);
  });

  it("stops at the last sample it can interpolate to, and resumes from it", () => {
    const resample = createResampler(32_000, 16_000);
    expect(Array.from(resample(Float32Array.from([0, 1, 2, 3, 4, 5, 6])))).toEqual([0, 2, 4]);
    // An empty post from the worklet changes nothing.
    expect(Array.from(resample(new Float32Array(0)))).toEqual([]);
    expect(Array.from(resample(Float32Array.from([7, 8, 9])))).toEqual([6, 8]);
  });

  it("gives the same output in chunks as in one piece", () => {
    // The worklet posts ~32 ms at a time; a seam between posts would be an
    // audible click every 32 ms, which the VAD could hear as noise. An
    // alternating signal makes any misplaced sample at a seam show. 1411
    // samples is what the worklet posts at 44.1 kHz, and isn't a whole number
    // of output steps, so output samples fall between chunks.
    const input = alternating(1411 * 20);
    const whole = createResampler(44_100, 16_000)(input);

    const chunked = createResampler(44_100, 16_000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 1411) {
      parts.push(...chunked(input.subarray(i, i + 1411)));
    }

    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(parts[i]).toBeCloseTo(whole[i]!, 5);
  });
});

describe("toInt16", () => {
  it("clamps out-of-range samples instead of wrapping them", () => {
    expect(Array.from(toInt16(Float32Array.from([2, -2, 0])))).toEqual([32767, -32768, 0]);
  });

  it("scales each sign to its own full range", () => {
    expect(Array.from(toInt16(Float32Array.from([0.5, -0.5])))).toEqual([16383, -16384]);
  });
});

describe("createTurnMessageHandler", () => {
  it("pairs a turn event with the audio message after it", async () => {
    const turns: Blob[] = [];
    let speechStarts = 0;
    const handle = createTurnMessageHandler({
      onSpeechStart: () => speechStarts++,
      onTurn: (audio) => turns.push(audio),
    });

    handle(JSON.stringify({ type: "speech_start" }));
    handle(JSON.stringify({ type: "pause", probability: 0.1 }));
    handle(JSON.stringify({ type: "turn", reason: "silence", probability: null }));
    handle(Int16Array.from([16384, -16384, 0, 32767]).buffer);

    expect(speechStarts).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.type).toBe("audio/wav");
    // The detector's samples survive the trip into the WAV, give or take rounding.
    const samples = await wavSamples(turns[0]!);
    expect(samples).toHaveLength(4);
    [16384, -16384, 0, 32767].forEach((expected, i) => {
      expect(Math.abs(samples[i]! - expected)).toBeLessThanOrEqual(1);
    });
  });

  it("hands over one turn per turn event, and none for a pause", () => {
    let turns = 0;
    const handle = createTurnMessageHandler({ onSpeechStart: () => {}, onTurn: () => turns++ });

    handle(JSON.stringify({ type: "turn", reason: "silence", probability: null }));
    handle(new Int16Array(4).buffer);
    handle(new Int16Array(4).buffer);
    expect(turns).toBe(1);

    handle(JSON.stringify({ type: "pause", probability: 0.1 }));
    handle(new Int16Array(4).buffer);
    expect(turns).toBe(1);
  });

  it("ignores audio that no turn event announced", () => {
    const turns: Blob[] = [];
    const handle = createTurnMessageHandler({
      onSpeechStart: () => {},
      onTurn: (audio) => turns.push(audio),
    });
    handle(new Int16Array(10).buffer);
    expect(turns).toHaveLength(0);
  });

  it("skips a message that isn't JSON", () => {
    let speechStarts = 0;
    const handle = createTurnMessageHandler({
      onSpeechStart: () => speechStarts++,
      onTurn: () => {},
    });
    handle("{not json");
    handle(JSON.stringify({ type: "speech_start" }));
    expect(speechStarts).toBe(1);
  });
});

describe("openTurnStream", () => {
  class FakeSocket {
    static OPEN = 1;
    static last: FakeSocket | null = null;
    readyState = 0;
    binaryType = "blob";
    sent: Int16Array[] = [];
    closeCalls = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(readonly url: string) {
      FakeSocket.last = this;
    }
    send(data: Int16Array) {
      this.sent.push(data);
    }
    close() {
      this.closeCalls++;
      this.readyState = 3;
    }
    /** The server accepting the connection. */
    accept() {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    }
    /** The server dropping it. */
    drop() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  let trackStops = 0;
  let track = new EventTarget();
  let contextsClosed = 0;
  let permission = deferred<MediaStream>();
  let workletLoaded = deferred<void>();
  let capture: { port: { onmessage: ((event: { data: Float32Array }) => void) | null } } | null =
    null;
  const saved: Record<string, unknown> = {};
  const g = globalThis as Record<string, unknown>;

  beforeEach(() => {
    trackStops = 0;
    track = new EventTarget();
    contextsClosed = 0;
    permission = deferred<MediaStream>();
    workletLoaded = deferred<void>();
    capture = null;
    FakeSocket.last = null;
    for (const key of ["WebSocket", "AudioContext", "AudioWorkletNode"]) saved[key] = g[key];
    saved.mediaDevices = navigator.mediaDevices;

    g.WebSocket = FakeSocket;
    const node = () => ({ connect: (next: unknown) => next });
    g.AudioContext = class {
      sampleRate = 48_000;
      destination = {};
      audioWorklet = { addModule: () => workletLoaded.promise };
      async resume() {}
      createMediaStreamSource = node;
      createGain = () => ({ ...node(), gain: { value: 1 } });
      async close() {
        contextsClosed++;
      }
    };
    g.AudioWorkletNode = class {
      port = { onmessage: null };
      connect = (next: unknown) => next;
      constructor() {
        capture = this;
      }
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => permission.promise },
    });
  });

  afterEach(() => {
    for (const key of ["WebSocket", "AudioContext", "AudioWorkletNode"]) g[key] = saved[key];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: saved.mediaDevices,
    });
  });

  const micStream = () =>
    ({
      getTracks: () => [
        Object.assign(track, {
          stop: () => {
            trackStops++;
          },
        }),
      ],
    }) as unknown as MediaStream;

  function handlers() {
    const errors: string[] = [];
    const levels: number[] = [];
    const h: TurnStreamHandlers = {
      onSpeechStart: () => {},
      onTurn: () => {},
      onLevel: (level) => levels.push(level),
      onError: (message) => errors.push(message),
    };
    return { h, errors, levels };
  }

  /** Runs the whole setup: connection, permission, and the capture worklet. */
  async function opened(h: TurnStreamHandlers) {
    const opening = openTurnStream("ws://127.0.0.1:1/?token=t", h);
    FakeSocket.last?.accept();
    await settle();
    permission.resolve(micStream());
    workletLoaded.resolve();
    const stream = await opening;
    return { stream, socket: FakeSocket.last! };
  }

  it("streams the microphone to the detector as 16 kHz 16-bit audio", async () => {
    const { h, levels } = handlers();
    const { socket } = await opened(h);

    capture?.port.onmessage?.({ data: new Float32Array(1536).fill(0.5) });

    expect(socket.binaryType).toBe("arraybuffer");
    // 1536 samples at 48 kHz are 512 at 16 kHz, give or take the last one.
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]!.length).toBeGreaterThanOrEqual(511);
    expect(socket.sent[0]![0]).toBe(16383);
    expect(levels[0]).toBeCloseTo(0.5, 5);
  });

  it("sends nothing once the socket is no longer open", async () => {
    const { h } = handlers();
    const { socket } = await opened(h);
    socket.readyState = 2;
    capture?.port.onmessage?.({ data: new Float32Array(1536) });
    expect(socket.sent).toHaveLength(0);
  });

  it("reports a dropped connection and releases the microphone", async () => {
    const { h, errors } = handlers();
    const { socket } = await opened(h);

    socket.drop();

    expect(errors).toEqual(["lost the connection to the turn detector"]);
    expect(trackStops).toBe(1);
    expect(contextsClosed).toBe(1);
  });

  it("reports a microphone that stops on its own, and closes the connection", async () => {
    const { h, errors } = handlers();
    const { socket } = await opened(h);

    track.dispatchEvent(new Event("ended"));

    expect(errors).toEqual(["the microphone stopped"]);
    expect(socket.closeCalls).toBe(1);
    expect(contextsClosed).toBe(1);
  });

  it("rejects without a microphone API, before connecting", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { h } = handlers();
    await expect(openTurnStream("ws://127.0.0.1:1/?token=t", h)).rejects.toThrow(
      /no microphone support/,
    );
    expect(FakeSocket.last).toBeNull();
  });

  it("doesn't connect when already stopped", async () => {
    const { h } = handlers();
    const abort = new AbortController();
    abort.abort();
    await expect(openTurnStream("ws://127.0.0.1:1/?token=t", h, abort.signal)).rejects.toThrow(
      /stopped before the microphone opened/,
    );
    expect(FakeSocket.last).toBeNull();
  });

  it("doesn't report its own close as a lost connection, and closes once", async () => {
    const { h, errors } = handlers();
    const { stream, socket } = await opened(h);

    stream.close();
    stream.close();

    expect(errors).toEqual([]);
    expect(socket.closeCalls).toBe(1);
    expect(trackStops).toBe(1);
  });

  it("rejects when the detector can't be reached", async () => {
    const { h } = handlers();
    const opening = openTurnStream("ws://127.0.0.1:1/?token=t", h);
    FakeSocket.last?.onerror?.();
    await expect(opening).rejects.toThrow(/could not reach the turn detector/);
  });

  it("closes the connection when the microphone is refused", async () => {
    const { h } = handlers();
    const opening = openTurnStream("ws://127.0.0.1:1/?token=t", h);
    FakeSocket.last?.accept();
    await settle();
    permission.reject(new Error("Permission denied"));

    await expect(opening).rejects.toThrow(/microphone unavailable: Permission denied/);
    expect(FakeSocket.last?.closeCalls).toBe(1);
  });

  it("releases a microphone granted after the connection dropped", async () => {
    const { h } = handlers();
    const opening = openTurnStream("ws://127.0.0.1:1/?token=t", h);
    FakeSocket.last?.accept();
    await settle();
    FakeSocket.last?.drop();
    permission.resolve(micStream());

    await expect(opening).rejects.toThrow(/lost the connection/);
    expect(trackStops).toBe(1);
  });

  it("never asks for the microphone when stopped while connecting", async () => {
    let asked = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => {
          asked++;
          return permission.promise;
        },
      },
    });
    const { h } = handlers();
    const abort = new AbortController();
    const opening = openTurnStream("ws://127.0.0.1:1/?token=t", h, abort.signal);
    abort.abort();
    FakeSocket.last?.accept();

    await expect(opening).rejects.toThrow(/stopped before the microphone opened/);
    expect(asked).toBe(0);
    expect(FakeSocket.last?.closeCalls).toBe(1);
  });

  it("gives up on a detector that never answers once stopped", async () => {
    const { h } = handlers();
    const abort = new AbortController();
    const opening = openTurnStream("ws://127.0.0.1:1/?token=t", h, abort.signal);
    abort.abort();

    await expect(settlesSoon(opening)).rejects.toThrow(/stopped before the microphone opened/);
    expect(FakeSocket.last?.closeCalls).toBe(1);
  });

  it("releases a microphone granted after a stop", async () => {
    const { h, errors } = handlers();
    const abort = new AbortController();
    const opening = openTurnStream("ws://127.0.0.1:1/?token=t", h, abort.signal);
    FakeSocket.last?.accept();
    await settle();
    abort.abort();
    permission.resolve(micStream());
    workletLoaded.resolve();

    await expect(settlesSoon(opening)).rejects.toThrow(/stopped before the microphone opened/);
    expect(trackStops).toBe(1);
    expect(errors).toEqual([]);
  });

  it("gives up when the connection drops while audio capture is starting", async () => {
    const { h } = handlers();
    const opening = openTurnStream("ws://127.0.0.1:1/?token=t", h);
    FakeSocket.last?.accept();
    await settle();
    permission.resolve(micStream());
    await settle();
    FakeSocket.last?.drop();
    workletLoaded.resolve();

    await expect(opening).rejects.toThrow(/lost the connection/);
    expect(trackStops).toBe(1);
    expect(contextsClosed).toBe(1);
  });
});
