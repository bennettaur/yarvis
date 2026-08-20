import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SILENCE_MS, MAX_UTTERANCE_MS, useVoiceRecorder } from "./useVoiceRecorder";

/**
 * happy-dom has none of MediaRecorder, AudioContext or mediaDevices, so these
 * install fakes as globals and drive them by hand. Globals rather than a
 * `mock.module` deliberately: a module stub would leak into every test file
 * that runs after this one (see `src/test/setup.ts`), and the fakes here need
 * to be driveable anyway — loudness has to be steered sample by sample to
 * exercise the silence detection.
 */

let currentRecorder: FakeMediaRecorder | null = null;
let openStreams = 0;
/** Loudness the analyser reports, 0..1. Tests move this to simulate speech. */
let amplitude = 0;
/** Resolves the pending getUserMedia, so a test can act mid-permission-prompt. */
let grantPermission: (() => void) | null = null;
let permissionMode: "grant" | "deny" | "hold" = "grant";

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
    openStreams--;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state: "recording" | "inactive" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    public stream: FakeStream,
    public options?: { mimeType?: string },
  ) {
    currentRecorder = this;
  }

  start() {
    this.state = "recording";
    // One chunk of audio, so the finished blob is non-empty.
    this.ondataavailable?.({ data: new Blob(["audio"]) });
  }

  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

class FakeAnalyser {
  fftSize = 1024;
  getByteTimeDomainData(target: Uint8Array) {
    // 128 is silence; the hook computes RMS around that midpoint.
    target.fill(Math.round(128 + amplitude * 128));
  }
}

class FakeAudioContext {
  closed = false;
  createAnalyser() {
    return new FakeAnalyser();
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  async close() {
    this.closed = true;
  }
}

function installFakes(): void {
  currentRecorder = null;
  openStreams = 0;
  amplitude = 0;
  grantPermission = null;
  permissionMode = "grant";

  const g = globalThis as Record<string, unknown>;
  g.MediaRecorder = FakeMediaRecorder;
  g.AudioContext = FakeAudioContext;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        if (permissionMode === "deny") throw new Error("Permission denied");
        if (permissionMode === "hold") {
          await new Promise<void>((resolve) => {
            grantPermission = resolve;
          });
        }
        openStreams++;
        return new FakeStream();
      },
    },
  });
}

interface Harness {
  recorder: ReturnType<typeof useVoiceRecorder>;
  utterances: Blob[];
  unmount: () => void;
}

/** Lets React flush and pending promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Mounts the hook and exposes its latest return value plus what it delivered.
 * Async because React commits the first render on a later tick, so `recorder`
 * isn't populated until after one.
 */
async function mountRecorder(
  options: { autoStopSilenceMs?: number | null; maxUtteranceMs?: number } = {},
): Promise<Harness> {
  installFakes();
  const utterances: Blob[] = [];
  const harness = { utterances } as Harness;

  function Probe() {
    harness.recorder = useVoiceRecorder({
      onUtterance: (audio) => utterances.push(audio),
      ...options,
    });
    return null;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  root.render(createElement(Probe));
  harness.unmount = () => {
    root.unmount();
    host.remove();
  };
  await settle();
  return harness;
}

/** Advances the hook's 100ms sampling loop by `steps` ticks at `level` loudness. */
async function tick(steps: number, level: number): Promise<void> {
  amplitude = level;
  for (let i = 0; i < steps; i++) await new Promise((resolve) => setTimeout(resolve, 100));
}

const SPEAKING = 0.2;
const SILENT = 0;

let active: Harness | null = null;

afterEach(() => {
  active?.unmount();
  active = null;
});

describe("useVoiceRecorder", () => {
  it("delivers the utterance after silence follows speech", async () => {
    active = await mountRecorder({ autoStopSilenceMs: 300 });
    await active.recorder.start();
    await settle();
    expect(active.recorder.recording).toBe(true);

    await tick(3, SPEAKING);
    await tick(5, SILENT);

    expect(active.utterances).toHaveLength(1);
  });

  it("does not end a turn on silence alone", async () => {
    active = await mountRecorder({ autoStopSilenceMs: 300 });
    await active.recorder.start();
    await settle();

    // Quiet from the start: nothing was said, so there is nothing to send.
    await tick(10, SILENT);

    expect(active.utterances).toHaveLength(0);
    expect(currentRecorder?.state).toBe("recording");
  });

  it("never auto-stops in push-to-talk mode", async () => {
    active = await mountRecorder({ autoStopSilenceMs: null });
    await active.recorder.start();
    await settle();

    await tick(3, SPEAKING);
    await tick(10, SILENT);
    expect(active.utterances).toHaveLength(0);

    active.recorder.stop();
    await settle();
    expect(active.utterances).toHaveLength(1);
  });

  it("discards the recording when the user stops it explicitly", async () => {
    active = await mountRecorder({ autoStopSilenceMs: null });
    await active.recorder.start();
    await settle();
    await tick(3, SPEAKING);

    active.recorder.stop({ discard: true });
    await settle();

    expect(active.utterances).toHaveLength(0);
    expect(openStreams).toBe(0);
  });

  it("throws away a capped recording that never heard speech", async () => {
    active = await mountRecorder({ autoStopSilenceMs: null, maxUtteranceMs: 500 });
    await active.recorder.start();
    await settle();

    // Loud enough that a silence timer would never fire, quiet enough that it
    // is not speech: a noisy room nobody is talking to.
    await tick(7, 0.03);

    expect(currentRecorder?.state).toBe("inactive");
    // A minute of ambient audio must not be uploaded to a third party.
    expect(active.utterances).toHaveLength(0);
  });

  it("still delivers a capped recording that did hear speech", async () => {
    active = await mountRecorder({ autoStopSilenceMs: null, maxUtteranceMs: 500 });
    await active.recorder.start();
    await settle();

    await tick(1, SPEAKING);
    await tick(7, 0.03);

    expect(active.utterances).toHaveLength(1);
  });

  it("opens only one stream when start is called twice in the permission window", async () => {
    active = await mountRecorder();
    permissionMode = "hold";

    const first = active.recorder.start();
    const second = active.recorder.start();
    grantPermission?.();
    const [firstOk, secondOk] = await Promise.all([first, second]);
    await settle();

    expect(firstOk).toBe(true);
    expect(secondOk).toBe(false);
    expect(openStreams).toBe(1);
  });

  it("releases a stream granted after the component went away", async () => {
    active = await mountRecorder();
    permissionMode = "hold";

    const starting = active.recorder.start();
    // The permission prompt is still up when the user switches tabs.
    active.unmount();
    active.unmount = () => {};
    grantPermission?.();

    expect(await starting).toBe(false);
    // The mic must not stay live with no component left to stop it.
    expect(openStreams).toBe(0);
  });

  it("reports a refused microphone and stays stopped", async () => {
    active = await mountRecorder();
    permissionMode = "deny";

    expect(await active.recorder.start()).toBe(false);
    await settle();

    expect(active.recorder.recording).toBe(false);
    expect(active.recorder.error).toMatch(/microphone unavailable/);
  });

  it("stops the microphone when unmounted mid-recording", async () => {
    active = await mountRecorder({ autoStopSilenceMs: null });
    await active.recorder.start();
    await settle();
    await tick(2, SPEAKING);
    expect(openStreams).toBe(1);

    active.unmount();
    active.unmount = () => {};

    expect(openStreams).toBe(0);
    // Releasing the mic matters more than delivering a half-utterance.
    expect(active.utterances).toHaveLength(0);
  });

  it("caps a recording at a minute by default", () => {
    // The tests above shorten it; production uses this value, and the README
    // tells the user about it.
    expect(MAX_UTTERANCE_MS).toBe(60_000);
    expect(DEFAULT_SILENCE_MS).toBe(1200);
  });
});
