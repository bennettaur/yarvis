import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TurnStreamHandlers } from "./turnStream";
import type { TurnDetectorStatus } from "./voice";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "./voiceConfig";

/**
 * The hook that makes a chat surface a voice surface.
 *
 * Its outside world arrives through the `io` option rather than a
 * `mock.module`: stubbing `./voice` or `./audioPlayback` globally would replace
 * the behaviour that those modules' own tests assert on, for every file that
 * runs after this one.
 */

let storedConfig: VoiceConfig = { ...DEFAULT_VOICE_CONFIG };
const savedPatches: Partial<VoiceConfig>[] = [];
const spoken: string[] = [];
let transcriptResult: string | Error = "turn the build green";

let deliverUtterance: (() => void) | null = null;

/** Transcriptions a test answers by hand, consumed one per call, in order. */
const transcribeGates: Promise<string>[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** What `send` answers; `false` is a surface refusing the turn. */
let sendResult: unknown;
/** Thrown by the next `send`, then cleared. */
let sendError: Error | null = null;

const RUNNING: TurnDetectorStatus = {
  state: "running",
  url: "ws://127.0.0.1:5555/?token=t",
  log: [],
  error: null,
};
let detectorStatus: TurnDetectorStatus = RUNNING;
/** The handlers of the turn stream the hook opened, standing in for the detector. */
let detector: TurnStreamHandlers | null = null;
let openedUrl: string | null = null;
let streamClosed = false;
/** Signals of replies playing now; a test aborts nothing itself, the hook does. */
const playing: AbortSignal[] = [];

function installRecorderFakes(): void {
  const g = globalThis as Record<string, unknown>;
  class FakeRecorder {
    static isTypeSupported = () => true;
    state: "recording" | "inactive" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() {
      this.state = "recording";
      this.ondataavailable?.({ data: new Blob(["audio"]) });
      deliverUtterance = () => {
        this.state = "inactive";
        this.onstop?.();
      };
    }
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  }
  g.MediaRecorder = FakeRecorder;
  g.AudioContext = class {
    createAnalyser() {
      return {
        fftSize: 1024,
        // Loud enough to register as speech, so an utterance is delivered.
        getByteTimeDomainData: (t: Uint8Array) => t.fill(180),
      };
    }
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    async close() {}
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
  });
}

const { useVoice } = await import("./useVoice");

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  voice: ReturnType<typeof useVoice>;
  sent: { text: string; source: string }[];
  rerender: (props: { streaming: string; busy: boolean }) => Promise<void>;
  unmount: () => void;
}

/** Mounts the hook with controllable `streaming`/`busy`, as a surface supplies. */
async function mountVoice(initial = { streaming: "", busy: false }): Promise<Harness> {
  installRecorderFakes();
  const sent: { text: string; source: string }[] = [];
  const harness = { sent } as Harness;

  const io = {
    transcribe: async () => {
      const gate = transcribeGates.shift();
      if (gate) return gate;
      if (transcriptResult instanceof Error) throw transcriptResult;
      return transcriptResult;
    },
    speak: async (request: { text: string }) => {
      spoken.push(request.text);
      return new Blob(["audio"]);
    },
    // Plays until stopped, like a real sentence that hasn't finished yet.
    playAudio: (_audio: Blob, signal: AbortSignal) => {
      playing.push(signal);
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
    startDetector: async () => detectorStatus,
    detectorStatus: async () => detectorStatus,
    openStream: async (url: string, handlers: TurnStreamHandlers) => {
      openedUrl = url;
      detector = handlers;
      streamClosed = false;
      return {
        close: () => {
          streamClosed = true;
        },
      };
    },
    // Decoding a fake blob is not the subject here.
    toWav: async (recording: Blob) => recording,
    loadConfig: async () => storedConfig,
    saveConfig: async (patch: Partial<VoiceConfig>) => {
      savedPatches.push(patch);
      storedConfig = { ...storedConfig, ...patch };
      return storedConfig;
    },
  } as unknown as Parameters<typeof useVoice>[0]["io"];

  function Probe({ streaming, busy }: { streaming: string; busy: boolean }) {
    harness.voice = useVoice({
      send: (text, options) => {
        if (sendError) {
          const error = sendError;
          sendError = null;
          throw error;
        }
        sent.push({ text, source: options.source });
        return sendResult;
      },
      streaming,
      busy,
      io,
    });
    return null;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  root.render(createElement(Probe, initial));
  harness.rerender = async (props) => {
    root.render(createElement(Probe, props));
    await settle();
  };
  harness.unmount = () => {
    root.unmount();
    host.remove();
  };
  await settle();
  return harness;
}

let active: Harness | null = null;

afterEach(() => {
  active?.unmount();
  active = null;
  storedConfig = { ...DEFAULT_VOICE_CONFIG };
  savedPatches.length = 0;
  spoken.length = 0;
  transcriptResult = "turn the build green";
  deliverUtterance = null;
  sendResult = undefined;
  sendError = null;
  detectorStatus = RUNNING;
  detector = null;
  openedUrl = null;
  streamClosed = false;
  playing.length = 0;
  transcribeGates.length = 0;
});

const configured: VoiceConfig = {
  ...DEFAULT_VOICE_CONFIG,
  sttProvider: "custom:local",
  sttModel: "gemma4:latest",
  ttsProvider: "custom:local",
  ttsModel: "soprano",
};

describe("useVoice", () => {
  it("picks up a voice activated elsewhere when the next turn starts", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();
    // The Chat tab stays mounted while the Voice page changes the stored config.
    storedConfig = { ...configured, activeVoiceId: "saved-voice" };

    await active.rerender({ streaming: "", busy: true });
    expect(active.voice.config.activeVoiceId).toBe("saved-voice");
  });

  it("reports which halves are configured", async () => {
    storedConfig = { ...configured, ttsProvider: "", ttsModel: "" };
    active = await mountVoice();
    expect(active.voice.ready).toEqual({ stt: true, tts: false });
  });

  it("sends a transcript through the surface's own send, marked as spoken", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();

    active.voice.startListening();
    await settle();
    deliverUtterance?.();
    await settle();

    // The turn goes to whatever model that surface uses; the hook only supplies
    // the words and the provenance.
    expect(active.sent).toEqual([{ text: "turn the build green", source: "voice" }]);
  });

  it("says nothing to the agent when the clip had no words in it", async () => {
    storedConfig = { ...configured };
    transcriptResult = "   ";
    active = await mountVoice();

    active.voice.startListening();
    await settle();
    deliverUtterance?.();
    await settle();

    expect(active.sent).toEqual([]);
  });

  it("explains an unconfigured microphone path rather than failing silently", async () => {
    storedConfig = { ...DEFAULT_VOICE_CONFIG };
    active = await mountVoice();

    active.voice.startListening();
    await settle();
    deliverUtterance?.();
    await settle();

    expect(active.voice.error).toMatch(/Settings → Voice/);
    expect(active.sent).toEqual([]);
  });

  it("speaks the reply a sentence at a time as it streams", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();

    // Long enough to clear the splitter's minimum; a short sentence rides along
    // with the next one rather than becoming its own synthesis call.
    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    expect(spoken).toEqual(["The build is green and the deploy finished a couple of minutes ago."]);

    // Only the newly-arrived text is spoken, not the whole buffer again.
    await active.rerender({
      streaming:
        "The build is green and the deploy finished a couple of minutes ago. Nothing else is outstanding on that branch, as far as I can tell. ",
      busy: true,
    });
    expect(spoken).toEqual([
      "The build is green and the deploy finished a couple of minutes ago.",
      "Nothing else is outstanding on that branch, as far as I can tell.",
    ]);
  });

  it("speaks the trailing partial sentence once the turn ends", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();

    await active.rerender({ streaming: "All done", busy: true });
    expect(spoken).toEqual([]);

    await active.rerender({ streaming: "", busy: false });
    expect(spoken).toEqual(["All done"]);
  });

  it("stays silent when speaking replies is off", async () => {
    storedConfig = { ...configured, speakReplies: false };
    active = await mountVoice();

    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    expect(spoken).toEqual([]);
  });

  it("stays silent when no text-to-speech backend is set", async () => {
    storedConfig = { ...configured, ttsProvider: "", ttsModel: "" };
    active = await mountVoice();

    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    expect(spoken).toEqual([]);
  });

  it("persists a toggle so every surface and the sidecar agree", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();

    await active.voice.updateConfig({ continuous: true });
    await settle();

    expect(savedPatches).toEqual([{ continuous: true }]);
    expect(active.voice.config.continuous).toBe(true);
  });

  it("drops queued speech when the turn is cancelled", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();

    await active.rerender({ streaming: "First sentence here, long enough to speak. ", busy: true });
    const spokenBefore = spoken.length;
    active.voice.cancel();
    await active.rerender({ streaming: "", busy: false });

    // Whatever was already handed over may finish; nothing new is queued.
    expect(spoken.length).toBe(spokenBefore);
  });
});

describe("useVoice in continuous mode", () => {
  const continuous: VoiceConfig = { ...configured, continuous: true };
  const turnAudio = () => new Blob(["pcm"], { type: "audio/wav" });

  async function listening(): Promise<Harness> {
    storedConfig = { ...continuous };
    const harness = await mountVoice();
    harness.voice.startListening();
    await settle();
    return harness;
  }

  it("streams to the turn detector and sends each finished turn", async () => {
    active = await listening();
    expect(openedUrl).toBe(RUNNING.url);
    expect(active.voice.recording).toBe(true);

    detector?.onTurn(turnAudio(), "complete");
    await settle();

    expect(active.sent).toEqual([{ text: "turn the build green", source: "voice" }]);
    // Still listening for the next turn without a click.
    expect(active.voice.recording).toBe(true);
  });

  it("holds turns finished mid-reply and sends them together when it ends", async () => {
    active = await listening();
    await active.rerender({ streaming: "", busy: true });

    transcriptResult = "and add a step";
    detector?.onTurn(turnAudio(), "complete");
    await settle();
    transcriptResult = "for two factor auth";
    detector?.onTurn(turnAudio(), "complete");
    await settle();

    expect(active.sent).toEqual([]);
    expect(active.voice.queued).toBe(2);

    await active.rerender({ streaming: "", busy: false });
    expect(active.sent).toEqual([{ text: "and add a step for two factor auth", source: "voice" }]);
    expect(active.voice.queued).toBe(0);
  });

  it("retries a refused turn once, then says it was dropped", async () => {
    active = await listening();
    // The surface refuses when a turn started between the check and the send.
    sendResult = false;

    detector?.onTurn(turnAudio(), "complete");
    await settle();

    expect(active.sent).toHaveLength(2);
    expect(active.voice.queued).toBe(0);
    expect(active.voice.error).toMatch(/dropped/);
  });

  it("stops the spoken reply when the user starts talking, and keeps it stopped", async () => {
    active = await listening();
    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    expect(playing).toHaveLength(1);

    detector?.onSpeechStart();
    await settle();
    expect(playing[0]?.aborted).toBe(true);

    // The rest of the reply that was cut off isn't spoken either.
    await active.rerender({
      streaming:
        "The build is green and the deploy finished a couple of minutes ago. Nothing else is outstanding on that branch, as far as I can tell. ",
      busy: true,
    });
    expect(spoken).toHaveLength(1);
  });

  it("drops held turns and closes the mic on cancel", async () => {
    active = await listening();
    await active.rerender({ streaming: "", busy: true });
    detector?.onTurn(turnAudio(), "complete");
    await settle();
    expect(active.voice.queued).toBe(1);

    active.voice.cancel();
    await active.rerender({ streaming: "", busy: false });

    expect(streamClosed).toBe(true);
    expect(active.sent).toEqual([]);
  });

  it("closes the mic when continuous mode is switched off", async () => {
    active = await listening();
    await active.voice.updateConfig({ continuous: false });
    await settle();

    expect(streamClosed).toBe(true);
    expect(active.voice.recording).toBe(false);
  });

  it("explains a detector that failed to start", async () => {
    detectorStatus = {
      state: "failed",
      url: null,
      log: [],
      error: "uv is not installed. Install it with `brew install uv`.",
    };
    active = await listening();

    expect(openedUrl).toBeNull();
    expect(active.voice.error).toMatch(/uv is not installed/);
    expect(active.voice.recording).toBe(false);
  });

  it("starts again on the next click after a failed start", async () => {
    detectorStatus = { state: "failed", url: null, log: [], error: "no uv" };
    active = await listening();
    expect(active.voice.error).toMatch(/no uv/);

    detectorStatus = RUNNING;
    active.voice.startListening();
    await settle();

    expect(openedUrl).toBe(RUNNING.url);
    expect(active.voice.recording).toBe(true);
    expect(active.voice.error).toBeNull();
  });

  it("starts again on the next click after the connection drops", async () => {
    active = await listening();
    detector?.onError("lost the connection to the turn detector");
    await settle();
    expect(active.voice.recording).toBe(false);

    openedUrl = null;
    active.voice.startListening();
    await settle();

    expect(openedUrl as string | null).toBe(RUNNING.url);
    expect(active.voice.recording).toBe(true);
  });

  it("waits for a detector that is still starting", async () => {
    detectorStatus = { state: "starting", url: null, log: [], error: null };
    active = await listening();
    expect(active.voice.starting).toBe(true);
    expect(openedUrl).toBeNull();

    detectorStatus = RUNNING;
    await settle(1100);

    expect(openedUrl).toBe(RUNNING.url);
    expect(active.voice.starting).toBe(false);
  });

  it("sends turns in the order spoken, even when the first transcribes slower", async () => {
    active = await listening();
    const first = deferred<string>();
    transcribeGates.push(first.promise, Promise.resolve("second"));

    detector?.onTurn(turnAudio(), "complete");
    detector?.onTurn(turnAudio(), "complete");
    await settle();
    expect(active.sent).toEqual([]);

    first.resolve("first");
    await settle();
    expect(active.sent.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("drops a turn still being transcribed when the user cancels", async () => {
    active = await listening();
    const pending = deferred<string>();
    transcribeGates.push(pending.promise);
    detector?.onTurn(turnAudio(), "complete");
    await settle();

    active.voice.cancel();
    pending.resolve("stop that");
    await settle();

    expect(active.sent).toEqual([]);
  });

  it("keeps listening after a transcription fails", async () => {
    active = await listening();
    transcriptResult = new Error("speech provider unavailable");

    detector?.onTurn(turnAudio(), "complete");
    await settle();
    expect(active.voice.error).toMatch(/speech provider unavailable/);
    expect(active.voice.recording).toBe(true);

    transcriptResult = "try again";
    detector?.onTurn(turnAudio(), "complete");
    await settle();
    expect(active.sent.map((m) => m.text)).toEqual(["try again"]);
  });

  it("keeps sending turns after one send throws", async () => {
    active = await listening();
    sendError = new Error("session create failed");

    detector?.onTurn(turnAudio(), "complete");
    await settle();
    expect(active.voice.error).toMatch(/session create failed/);

    detector?.onTurn(turnAudio(), "complete");
    await settle();
    expect(active.sent).toHaveLength(1);
  });
});
