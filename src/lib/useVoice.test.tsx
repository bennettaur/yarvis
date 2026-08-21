import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
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
      if (transcriptResult instanceof Error) throw transcriptResult;
      return transcriptResult;
    },
    speak: async (request: { text: string }) => {
      spoken.push(request.text);
      return new Blob(["audio"]);
    },
    playAudio: async () => {},
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
        sent.push({ text, source: options.source });
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
});

const configured: VoiceConfig = {
  ...DEFAULT_VOICE_CONFIG,
  sttProvider: "custom:local",
  sttModel: "gemma4:latest",
  ttsProvider: "custom:local",
  ttsModel: "soprano",
};

describe("useVoice", () => {
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

    await active.voice.updateConfig({ handsFree: true });
    await settle();

    expect(savedPatches).toEqual([{ handsFree: true }]);
    expect(active.voice.config.handsFree).toBe(true);
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
