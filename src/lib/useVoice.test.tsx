import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "../test/render";
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
let transcribeCalls = 0;
/** Transcriptions that have answered or thrown; the hook acts on each right after. */
let transcriptionsDone = 0;
/** The config `loadConfig` last answered. */
let loadedConfig: VoiceConfig | null = null;

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
/**
 * When set, `send` answers this instead, like the real surface's send, which
 * only settles once the reply has finished.
 */
let sendSettles: Promise<unknown> | null = null;

const RUNNING: TurnDetectorStatus = {
  state: "running",
  url: "ws://127.0.0.1:5555/?token=t",
  log: [],
  error: null,
};
let detectorStatus: TurnDetectorStatus = RUNNING;
/** Thrown by `startDetector`, as when the sidecar can't be reached. */
let detectorError: Error | null = null;
/** When set, each status poll answers with this once it resolves, like a slow sidecar. */
let statusGate: Promise<TurnDetectorStatus> | null = null;
let statusPolls = 0;
let statusAnswers = 0;
/** When set, opening the stream waits for it, like a pending permission prompt. */
let streamOpens: Promise<void> | null = null;
/** The handlers of the turn stream the hook opened, standing in for the detector. */
let detector: TurnStreamHandlers | null = null;
let openedUrl: string | null = null;
let streamClosed = false;
/** The signal the hook handed the last stream it opened. */
let streamSignal: AbortSignal | null = null;
/** Signals of replies playing now; a test aborts nothing itself, the hook does. */
const playing: AbortSignal[] = [];
/** Ends the sentence playing now, as if it had finished on its own. */
const finishPlayback: (() => void)[] = [];
/** Thrown by `toWav`, as when a recording can't be decoded. */
let wavError: Error | null = null;

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
        deliverUtterance = null;
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

type Voice = ReturnType<typeof useVoice>;

interface Harness {
  /** The hook's result as of the latest render. */
  voice: Voice;
  /**
   * Every render whose effects have run, oldest first. `id` names the props it
   * rendered with; the hook's own effects run before the entry is added.
   */
  commits: { id: number; voice: Voice }[];
  sent: { text: string; source: string }[];
  /** Renders with new props and waits for that render's effects to run. */
  rerender: (props: { streaming: string; busy: boolean; visible?: boolean }) => Promise<void>;
  unmount: () => void;
}

/** Mounts the hook with controllable `streaming`/`busy`, as a surface supplies. */
async function mountVoice(initial = { streaming: "", busy: false }): Promise<Harness> {
  installRecorderFakes();
  const sent: { text: string; source: string }[] = [];
  const harness = { sent, commits: [] as Harness["commits"] } as Harness;

  const io = {
    transcribe: async () => {
      transcribeCalls++;
      try {
        const gate = transcribeGates.shift();
        if (gate) return await gate;
        if (transcriptResult instanceof Error) throw transcriptResult;
        return transcriptResult;
      } finally {
        transcriptionsDone++;
      }
    },
    speak: async (request: { text: string }) => {
      spoken.push(request.text);
      return new Blob(["audio"]);
    },
    // Plays until stopped or finished by the test, like a real sentence.
    playAudio: (_audio: Blob, signal: AbortSignal) => {
      playing.push(signal);
      return new Promise<void>((resolve) => {
        finishPlayback.push(resolve);
        signal.addEventListener("abort", () => resolve());
      });
    },
    startDetector: async () => {
      if (detectorError) throw detectorError;
      return detectorStatus;
    },
    detectorStatus: async () => {
      statusPolls++;
      const status = statusGate ? await statusGate : detectorStatus;
      statusAnswers++;
      return status;
    },
    detectorPollMs: 1,
    openStream: async (url: string, handlers: TurnStreamHandlers, signal?: AbortSignal) => {
      streamSignal = signal ?? null;
      if (streamOpens) await streamOpens;
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
    toWav: async (recording: Blob) => {
      if (wavError) throw wavError;
      return recording;
    },
    loadConfig: async () => {
      loadedConfig = storedConfig;
      return storedConfig;
    },
    saveConfig: async (patch: Partial<VoiceConfig>) => {
      savedPatches.push(patch);
      storedConfig = { ...storedConfig, ...patch };
      return storedConfig;
    },
  } as unknown as Parameters<typeof useVoice>[0]["io"];

  function Probe({
    id,
    streaming,
    busy,
    visible = true,
  }: {
    id: number;
    streaming: string;
    busy: boolean;
    visible?: boolean;
  }) {
    const voice = useVoice({
      send: (text, options) => {
        if (sendError) {
          const error = sendError;
          sendError = null;
          throw error;
        }
        sent.push({ text, source: options.source });
        return sendSettles ?? sendResult;
      },
      streaming,
      busy,
      visible,
      io,
    });
    harness.voice = voice;
    // Declared after `useVoice`, so its effects have run by the time this one does.
    useEffect(() => {
      harness.commits.push({ id, voice });
    });
    return null;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  let renderId = 0;
  root.render(createElement(Probe, { ...initial, id: renderId }));
  harness.rerender = async (props) => {
    const id = ++renderId;
    root.render(createElement(Probe, { ...props, id }));
    await waitFor(() => (lastCommit(harness)?.id ?? -1) >= id, "the new props to render");
  };
  harness.unmount = () => {
    root.unmount();
    host.remove();
  };
  await waitFor(
    () => loadedConfig !== null && lastCommit(harness)?.voice.config === loadedConfig,
    "the stored config to load",
  );
  return harness;
}

function lastCommit(harness: Harness): Harness["commits"][number] | undefined {
  return harness.commits[harness.commits.length - 1];
}

/**
 * Waits for the render after the first one whose effects saw `condition`. A
 * failed start disarms the mic from an effect, and a click made before that
 * render lands is merged into it and lost.
 */
async function waitForRenderAfter(
  harness: Harness,
  condition: (voice: Voice) => boolean,
  what: string,
): Promise<void> {
  await waitFor(() => {
    const first = harness.commits.findIndex((commit) => condition(commit.voice));
    return first !== -1 && harness.commits.length > first + 1;
  }, `a render after ${what}`);
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
  sendSettles = null;
  detectorStatus = RUNNING;
  detectorError = null;
  streamOpens = null;
  detector = null;
  openedUrl = null;
  streamClosed = false;
  streamSignal = null;
  playing.length = 0;
  finishPlayback.length = 0;
  wavError = null;
  transcribeGates.length = 0;
  transcribeCalls = 0;
  transcriptionsDone = 0;
  loadedConfig = null;
  statusGate = null;
  statusPolls = 0;
  statusAnswers = 0;
  setSystemTime();
});

const configured: VoiceConfig = {
  ...DEFAULT_VOICE_CONFIG,
  sttProvider: "custom:local",
  sttModel: "gemma4:latest",
  ttsProvider: "custom:local",
  ttsModel: "soprano",
};

describe("useVoice", () => {
  /** Starts push-to-talk and ends the utterance once the recorder is running. */
  async function speakUtterance(harness: Harness): Promise<void> {
    harness.voice.startListening();
    await waitFor(() => deliverUtterance !== null, "the recorder to start");
    deliverUtterance?.();
  }

  it("picks up a voice activated elsewhere when the next turn starts", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();
    // The Chat tab stays mounted while the Voice page changes the stored config.
    storedConfig = { ...configured, activeVoiceId: "saved-voice" };

    await active.rerender({ streaming: "", busy: true });
    await waitFor(
      () => active?.voice.config.activeVoiceId === "saved-voice",
      "the config to reload",
    );
  });

  it("reports which halves are configured", async () => {
    storedConfig = { ...configured, ttsProvider: "", ttsModel: "" };
    active = await mountVoice();
    expect(active.voice.ready).toEqual({ stt: true, tts: false });
  });

  it("sends a transcript through the surface's own send, marked as spoken", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();

    await speakUtterance(active);
    await waitFor(() => active?.sent.length === 1, "the transcript to be sent");

    // The turn goes to whatever model that surface uses; the hook only supplies
    // the words and the provenance.
    expect(active.sent).toEqual([{ text: "turn the build green", source: "voice" }]);
  });

  it("shows why a recording couldn't be sent", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();
    wavError = new Error("could not decode the recording");

    await speakUtterance(active);
    await waitFor(
      () => /could not decode the recording/.test(active?.voice.error ?? ""),
      "the decode error",
    );

    wavError = null;
    sendError = new Error("session create failed");
    await speakUtterance(active);
    await waitFor(() => /session create failed/.test(active?.voice.error ?? ""), "the send error");
  });

  it("doesn't send a recording cancelled while it was being transcribed", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();
    const pending = deferred<string>();
    transcribeGates.push(pending.promise);

    await speakUtterance(active);
    await waitFor(() => transcribeCalls === 1, "transcription to start");
    active.voice.cancel();
    pending.resolve("delete the branch");
    await waitFor(() => transcriptionsDone === 1, "transcription to finish");

    expect(active.sent).toEqual([]);
  });

  it("says nothing to the agent when the clip had no words in it", async () => {
    storedConfig = { ...configured };
    transcriptResult = "   ";
    active = await mountVoice();

    await speakUtterance(active);
    await waitFor(() => transcriptionsDone === 1, "transcription to finish");

    expect(active.sent).toEqual([]);
  });

  it("explains an unconfigured microphone path rather than failing silently", async () => {
    storedConfig = { ...DEFAULT_VOICE_CONFIG };
    active = await mountVoice();

    await speakUtterance(active);
    await waitFor(() => /Settings → Voice/.test(active?.voice.error ?? ""), "the setup hint");

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
    await waitFor(() => active?.voice.config.continuous === true, "the toggle to apply");

    expect(savedPatches).toEqual([{ continuous: true }]);
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

  it("doesn't speak the reply again from the top when it keeps streaming after a cancel", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();
    const first = "First sentence here, comfortably long enough to be spoken on its own. ";
    await active.rerender({ streaming: first, busy: true });
    expect(spoken).toHaveLength(1);

    active.voice.cancel();
    await active.rerender({
      streaming: `${first}And a second sentence that keeps the reply going for a while. `,
      busy: true,
    });
    expect(spoken).toHaveLength(1);
  });

  it("shows the push-to-talk microphone's level", async () => {
    storedConfig = { ...configured };
    active = await mountVoice();
    active.voice.startListening();
    await waitFor(() => (active?.voice.level.get() ?? 0) > 0, "the level to rise");
  });
});

describe("useVoice in continuous mode", () => {
  const continuous: VoiceConfig = { ...configured, continuous: true };
  const turnAudio = () => new Blob(["pcm"], { type: "audio/wav" });
  const STARTING: TurnDetectorStatus = { state: "starting", url: null, log: [], error: null };

  /** Mounts in continuous mode and clicks the mic, then waits for `until`. */
  async function listening(
    until: (harness: Harness) => boolean = (harness) => harness.voice.recording,
    what = "the mic to open",
  ): Promise<Harness> {
    storedConfig = { ...continuous };
    const harness = await mountVoice();
    harness.voice.startListening();
    await waitFor(() => until(harness), what);
    return harness;
  }

  const failed = (harness: Harness) => harness.voice.error !== null;

  it("streams to the turn detector and sends each finished turn", async () => {
    active = await listening();
    expect(openedUrl).toBe(RUNNING.url);
    expect(active.voice.recording).toBe(true);

    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 1, "the turn to be sent");

    expect(active.sent).toEqual([{ text: "turn the build green", source: "voice" }]);
    // Still listening for the next turn without a click.
    expect(active.voice.recording).toBe(true);
  });

  it("holds turns finished mid-reply and sends them together when it ends", async () => {
    active = await listening();
    await active.rerender({ streaming: "", busy: true });

    transcriptResult = "and add a step";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 1, "the first turn to be held");
    transcriptResult = "for two factor auth";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 2, "the second turn to be held");

    expect(active.sent).toEqual([]);

    await active.rerender({ streaming: "", busy: false });
    expect(active.sent).toEqual([{ text: "and add a step for two factor auth", source: "voice" }]);
    await waitFor(() => active?.voice.queued === 0, "the held turns to clear");
  });

  it("doesn't send a turn ahead of ones already held", async () => {
    active = await listening();
    const firstSend = deferred<unknown>();
    sendSettles = firstSend.promise;
    transcriptResult = "first";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 1, "the first turn to be sent");
    transcriptResult = "second";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 1, "the second turn to be held");

    const third = deferred<string>();
    transcribeGates.push(third.promise);
    detector?.onTurn(turnAudio());
    await waitFor(() => transcribeCalls === 3, "the third turn to start transcribing");
    // The third transcript lands once the send has settled, but before the
    // held turn has gone out.
    firstSend.resolve(undefined);
    third.resolve("third");
    await waitFor(
      () => active?.sent.length === 2 && active.voice.queued === 0,
      "the held turns to go out",
    );

    expect(active.sent.map((m) => m.text)).toEqual(["first", "second third"]);
  });

  it("keeps a refused turn ahead of turns said after it", async () => {
    active = await listening();
    const firstSend = deferred<unknown>();
    sendSettles = firstSend.promise;
    transcriptResult = "first";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 1, "the first turn to be sent");
    transcriptResult = "second";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 1, "the second turn to be held");

    sendSettles = null;
    firstSend.resolve(false);
    await waitFor(
      () => active?.sent.length === 2 && active.voice.queued === 0,
      "the held turns to go out",
    );

    expect(active.sent.map((m) => m.text)).toEqual(["first", "first second"]);
  });

  it("retries a refused turn once, then says it was dropped", async () => {
    active = await listening();
    // The surface refuses when a turn started between the check and the send.
    sendResult = false;

    detector?.onTurn(turnAudio());
    await waitFor(() => /dropped/.test(active?.voice.error ?? ""), "the dropped notice");

    expect(active.sent).toHaveLength(2);
    expect(active.voice.queued).toBe(0);
  });

  it("stops the spoken reply when the user starts talking, and keeps it stopped", async () => {
    active = await listening();
    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    await waitFor(() => playing.length === 1, "the reply to start playing");

    detector?.onSpeechStart();
    expect(playing[0]?.aborted).toBe(true);

    // The rest of the reply that was cut off isn't spoken either.
    await active.rerender({
      streaming:
        "The build is green and the deploy finished a couple of minutes ago. Nothing else is outstanding on that branch, as far as I can tell. ",
      busy: true,
    });
    expect(spoken).toHaveLength(1);

    // The next reply is spoken again.
    await active.rerender({ streaming: "", busy: false });
    await active.rerender({
      streaming: "Done, the logs from the failed run are attached to the incident ticket. ",
      busy: true,
    });
    expect(spoken).toEqual([
      "The build is green and the deploy finished a couple of minutes ago.",
      "Done, the logs from the failed run are attached to the incident ticket.",
    ]);
  });

  it("doesn't start speaking a reply the user talked over before it began", async () => {
    active = await listening();
    // The agent is still thinking, so nothing is playing yet.
    await active.rerender({ streaming: "", busy: true });
    detector?.onSpeechStart();

    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    expect(spoken).toEqual([]);
  });

  it("speaks the next reply after cutting in on a turn that ended with no text", async () => {
    active = await listening();
    expect(detector).not.toBeNull();
    await active.rerender({ streaming: "", busy: true });
    (detector as TurnStreamHandlers).onSpeechStart();
    // The turn errors or is stopped before any reply text arrives.
    await active.rerender({ streaming: "", busy: false });

    await active.rerender({
      streaming: "Done, the logs from the failed run are attached to the incident ticket. ",
      busy: true,
    });
    expect(spoken).toEqual([
      "Done, the logs from the failed run are attached to the incident ticket.",
    ]);
  });

  it("doesn't speak a reply whose send was still settling when the surface was cancelled", async () => {
    active = await listening();
    const reply = deferred<unknown>();
    sendSettles = reply.promise;
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 1, "the turn to be sent");

    // Hidden before the surface reports itself busy.
    active.voice.cancel();
    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    expect(spoken).toEqual([]);
  });

  it("treats a turn that starts just after the reply finished playing as possible echo", async () => {
    const reply = "The build is green and the deploy finished a couple of minutes ago. ";
    active = await listening();
    await active.rerender({ streaming: reply, busy: true });
    await active.rerender({ streaming: "", busy: false });
    await waitFor(
      () => active?.voice.phase === "speaking" && finishPlayback.length === 1,
      "the reply to start playing",
    );
    finishPlayback[0]?.();
    await waitFor(() => active?.voice.phase === "idle", "the reply to finish");

    // The tail of the reply, reaching the detector after playback ended.
    detector?.onSpeechStart();
    transcriptResult = "the deploy finished a couple of minutes ago";
    detector?.onTurn(turnAudio());
    await waitFor(() => transcriptionsDone === 1, "the echo to be transcribed");
    expect(active.sent).toEqual([]);

    // A short turn is the user's, even in the tail. Punctuation isn't a word.
    detector?.onSpeechStart();
    transcriptResult = "deploy — finished";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 1, "the short turn to be sent");
    expect(active.sent.map((m) => m.text)).toEqual(["deploy — finished"]);

    // Well after the reply, the same words are the user's.
    setSystemTime(new Date(Date.now() + 5_000));
    detector?.onSpeechStart();
    transcriptResult = "the deploy finished a couple of minutes ago";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 2, "the later turn to be sent");
    expect(active.sent.map((m) => m.text)).toEqual([
      "deploy — finished",
      "the deploy finished a couple of minutes ago",
    ]);
  });

  it("stops the last reply's unfinished speech when the next reply starts", async () => {
    active = await listening();
    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    // The turn ends while its last sentence is still playing.
    await active.rerender({ streaming: "", busy: false });
    await waitFor(() => playing.length === 1, "the reply to start playing");
    expect(playing[0]?.aborted).toBe(false);

    await active.rerender({ streaming: "Here is the next answer, about the logs. ", busy: true });
    expect(playing[0]?.aborted).toBe(true);
  });

  it("drops a turn that only repeats the reply it was heard over", async () => {
    active = await listening();
    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });

    // The reply leaking past echo cancellation.
    detector?.onSpeechStart();
    transcriptResult = "the deploy finished a couple of minutes ago";
    detector?.onTurn(turnAudio());
    await waitFor(() => transcriptionsDone === 1, "the echo to be transcribed");
    // The user's own words, said over the reply.
    detector?.onSpeechStart();
    transcriptResult = "hold on, check the staging logs first";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 1, "the user's turn to be held");

    await active.rerender({ streaming: "", busy: false });
    expect(active.sent.map((m) => m.text)).toEqual(["hold on, check the staging logs first"]);
  });

  it("doesn't speak over a user who starts talking before the surface reports itself busy", async () => {
    active = await listening();
    sendSettles = deferred<unknown>().promise;
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 1, "the turn to be sent");

    // Still sending: `busy` hasn't flipped yet.
    detector?.onSpeechStart();
    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    expect(spoken).toEqual([]);
  });

  it("only treats a turn as echo when the reply was playing as it started", async () => {
    active = await listening();
    await active.rerender({
      streaming: "The build is green and the deploy finished a couple of minutes ago. ",
      busy: true,
    });
    // Cutting in stops the reply.
    detector?.onSpeechStart();
    transcriptResult = "hold on";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 1, "the first turn to be held");
    // Nothing is playing now, so the reply's own words are the user's.
    detector?.onSpeechStart();
    transcriptResult = "the deploy finished a couple of minutes ago";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 2, "the second turn to be held");

    await active.rerender({ streaming: "", busy: false });
    expect(active.sent.map((m) => m.text)).toEqual([
      "hold on the deploy finished a couple of minutes ago",
    ]);
  });

  it("closes the mic and drops held turns when the surface is hidden", async () => {
    active = await listening();
    await active.rerender({ streaming: "", busy: true });
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 1, "the turn to be held");

    await active.rerender({ streaming: "", busy: true, visible: false });
    await waitFor(
      () => streamClosed && active?.voice.recording === false && active.voice.queued === 0,
      "the mic to close and the held turn to drop",
    );

    await active.rerender({ streaming: "", busy: false, visible: false });
    expect(active.sent).toEqual([]);
  });

  it("transcribes and holds turns while the last one's reply is still running", async () => {
    active = await listening();
    const reply = deferred<unknown>();
    sendSettles = reply.promise;

    transcriptResult = "summarise the incident";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 1, "the first turn to be sent");
    transcriptResult = "and who was paged";
    detector?.onTurn(turnAudio());
    // Held at once, not stuck behind the first turn's reply.
    await waitFor(() => active?.voice.queued === 1, "the second turn to be held");
    expect(active.sent.map((m) => m.text)).toEqual(["summarise the incident"]);

    sendSettles = null;
    reply.resolve(true);
    await waitFor(() => active?.sent.length === 2, "the held turn to go out");
    expect(active.sent.map((m) => m.text)).toEqual(["summarise the incident", "and who was paged"]);
  });

  it("drops held turns and closes the mic on cancel", async () => {
    active = await listening();
    await active.rerender({ streaming: "", busy: true });
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 1, "the turn to be held");

    active.voice.cancel();
    await active.rerender({ streaming: "", busy: false });
    await waitFor(() => streamClosed, "the mic to close");

    expect(active.sent).toEqual([]);
  });

  it("closes the mic on stop and still sends turns already held", async () => {
    active = await listening();
    await active.rerender({ streaming: "", busy: true });
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.voice.queued === 1, "the turn to be held");

    active.voice.stopListening();
    await waitFor(() => streamClosed && active?.voice.recording === false, "the mic to close");

    await active.rerender({ streaming: "", busy: false });
    expect(active.sent).toEqual([{ text: "turn the build green", source: "voice" }]);
  });

  it("reports the microphone level while listening, and zero once closed", async () => {
    active = await listening();
    detector?.onLevel(0.3);
    expect(active.voice.level.get()).toBe(0.3);

    active.voice.stopListening();
    await waitFor(() => active?.voice.level.get() === 0, "the level to drop");
  });

  it("never opens the mic when cancelled while the detector is starting", async () => {
    detectorStatus = STARTING;
    const poll = deferred<TurnDetectorStatus>();
    statusGate = poll.promise;
    active = await listening(() => statusPolls === 1, "the first status poll");

    active.voice.cancel();
    await waitFor(() => active?.voice.starting === false, "the cancel to tear down");
    // The poll that was in flight comes back ready.
    poll.resolve(RUNNING);
    await waitFor(() => statusAnswers === 1, "the poll to answer");

    expect(openedUrl).toBeNull();
  });

  it("closes a stream that finishes opening after cancel", async () => {
    const permission = deferred<void>();
    streamOpens = permission.promise;
    active = await listening(() => streamSignal !== null, "the stream to start opening");

    active.voice.cancel();
    await waitFor(() => streamSignal?.aborted === true, "the cancel to tear down");
    permission.resolve();
    await waitFor(() => openedUrl !== null, "the stream to finish opening");

    expect(openedUrl).toBe(RUNNING.url);
    expect(streamClosed).toBe(true);
    expect(active.voice.recording).toBe(false);
  });

  it("stops a stream that is still opening when cancelled", async () => {
    streamOpens = deferred<void>().promise;
    active = await listening(() => streamSignal !== null, "the stream to start opening");
    expect(streamSignal?.aborted).toBe(false);

    active.voice.cancel();
    await waitFor(() => streamSignal?.aborted === true, "the open to be aborted");
  });

  it("explains a sidecar it can't reach, and tries again on the next click", async () => {
    detectorError = new Error("sidecar unreachable");
    active = await listening(failed, "the start to fail");
    expect(active.voice.error).toMatch(/sidecar unreachable/);
    expect(active.voice.starting).toBe(false);
    expect(active.voice.recording).toBe(false);

    await waitForRenderAfter(active, (v) => v.error !== null, "the failure");
    detectorError = null;
    active.voice.startListening();
    await waitFor(() => openedUrl === RUNNING.url, "the mic to open");
  });

  it("closes the mic when continuous mode is switched off", async () => {
    active = await listening();
    await active.voice.updateConfig({ continuous: false });
    await waitFor(() => streamClosed && active?.voice.recording === false, "the mic to close");
  });

  it("explains a detector that failed to start", async () => {
    detectorStatus = {
      state: "failed",
      url: null,
      log: [],
      error: "uv is not installed. Install it with `brew install uv`.",
    };
    active = await listening(failed, "the start to fail");

    expect(openedUrl).toBeNull();
    expect(active.voice.error).toMatch(/uv is not installed/);
    expect(active.voice.recording).toBe(false);
  });

  it("starts again on the next click after a failed start", async () => {
    detectorStatus = { state: "failed", url: null, log: [], error: "no uv" };
    active = await listening(failed, "the start to fail");
    expect(active.voice.error).toMatch(/no uv/);

    await waitForRenderAfter(active, (v) => v.error !== null, "the failure");
    detectorStatus = RUNNING;
    active.voice.startListening();
    await waitFor(() => active?.voice.recording === true, "the mic to open");

    expect(openedUrl).toBe(RUNNING.url);
    expect(active.voice.error).toBeNull();
  });

  it("shows why the mic closed over an older error", async () => {
    active = await listening();
    sendError = new Error("session create failed");
    detector?.onTurn(turnAudio());
    await waitFor(() => /session create failed/.test(active?.voice.error ?? ""), "the send error");

    detector?.onError("lost the connection to the turn detector");
    await waitFor(
      () => active?.voice.error === "lost the connection to the turn detector",
      "the connection error",
    );
  });

  it("closes the mic when the window is hidden", async () => {
    active = await listening();
    const state = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => streamClosed && active?.voice.recording === false, "the mic to close");
    } finally {
      if (state) Object.defineProperty(document, "visibilityState", state);
      else delete (document as { visibilityState?: string }).visibilityState;
    }
  });

  it("starts again on the next click after the connection drops", async () => {
    active = await listening();
    detector?.onError("lost the connection to the turn detector");
    await waitForRenderAfter(active, (v) => v.error !== null, "the dropped connection");
    expect(active.voice.recording).toBe(false);

    openedUrl = null;
    active.voice.startListening();
    await waitFor(() => active?.voice.recording === true, "the mic to reopen");

    expect(openedUrl as string | null).toBe(RUNNING.url);
  });

  it("waits for a detector that is still starting", async () => {
    detectorStatus = STARTING;
    active = await listening(() => statusPolls > 0, "the detector to be polled");
    expect(active.voice.starting).toBe(true);
    expect(openedUrl).toBeNull();

    detectorStatus = RUNNING;
    await waitFor(() => active?.voice.starting === false, "the detector to be ready");

    expect(openedUrl).toBe(RUNNING.url);
  });

  it("sends turns in the order spoken, even when the first transcribes slower", async () => {
    active = await listening();
    const first = deferred<string>();
    transcribeGates.push(first.promise, Promise.resolve("second"));

    detector?.onTurn(turnAudio());
    detector?.onTurn(turnAudio());
    await waitFor(() => transcribeCalls === 1, "the first turn to start transcribing");
    expect(active.sent).toEqual([]);

    first.resolve("first");
    await waitFor(() => active?.sent.length === 2, "both turns to be sent");
    expect(active.sent.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("drops a turn still being transcribed when the user cancels", async () => {
    active = await listening();
    expect(detector).not.toBeNull();
    const pending = deferred<string>();
    transcribeGates.push(pending.promise);
    detector?.onTurn(turnAudio());
    await waitFor(() => transcribeCalls === 1, "transcription to start");

    active.voice.cancel();
    pending.resolve("stop that");
    await waitFor(() => transcriptionsDone === 1, "transcription to finish");

    expect(active.sent).toEqual([]);
  });

  it("keeps listening after a transcription fails", async () => {
    active = await listening();
    transcriptResult = new Error("speech provider unavailable");

    detector?.onTurn(turnAudio());
    await waitFor(
      () => /speech provider unavailable/.test(active?.voice.error ?? ""),
      "the transcription error",
    );
    expect(active.voice.recording).toBe(true);

    transcriptResult = "try again";
    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 1, "the next turn to be sent");
    expect(active.sent.map((m) => m.text)).toEqual(["try again"]);
  });

  it("keeps sending turns after one send throws", async () => {
    active = await listening();
    sendError = new Error("session create failed");

    detector?.onTurn(turnAudio());
    await waitFor(() => /session create failed/.test(active?.voice.error ?? ""), "the send error");

    detector?.onTurn(turnAudio());
    await waitFor(() => active?.sent.length === 1, "the next turn to be sent");
    expect(active.sent).toHaveLength(1);
  });
});
