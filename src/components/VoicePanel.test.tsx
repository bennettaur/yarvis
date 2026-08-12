import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as api from "../lib/api";
import { mountForInteraction, renderToHtml } from "../test/render";

/**
 * The sidecar client is stubbed by spreading the real module and replacing only
 * `sidecarFetch`. Replacing the module wholesale — as most component tests here
 * do — drops `ensureOk` and `streamSSE` for every file that runs after this
 * one, which is the leak `src/test/setup.ts` warns about; keeping the real
 * exports means only the transport is faked.
 */

interface Recorded {
  path: string;
  body: unknown;
  init: RequestInit;
}

const requests: Recorded[] = [];
/** Events the fake chat stream emits, as raw SSE payloads. */
let chatEvents: unknown[] = [];
let transcript = "yes please";
/**
 * When set, the chat stream stays open after emitting `chatEvents` instead of
 * ending. A real turn behaves that way while a tool call waits on the user, and
 * whether the approval prompt is still on screen depends on it.
 */
let holdStreamOpen = false;
let closeStream: (() => void) | null = null;

function sse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      if (!holdStreamOpen) {
        controller.close();
        return;
      }
      closeStream = () => {
        controller.close();
        closeStream = null;
      };
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

mock.module("../lib/api", () => ({
  ...api,
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    requests.push({ path, body, init });
    if (path.startsWith("/api/voice/providers")) {
      return json([
        {
          id: "huggingface",
          label: "Hugging Face",
          available: true,
          sttModels: ["openai/whisper-large-v3-turbo"],
          ttsModels: ["hexgrad/Kokoro-82M"],
        },
      ]);
    }
    if (path.startsWith("/api/voice/transcribe")) return json({ text: transcript });
    if (path.startsWith("/api/voice/speak")) return new Response(new Uint8Array([1]));
    if (path.startsWith("/api/chat/providers")) {
      return json([
        { id: "cerebras", label: "Cerebras", models: ["zai-glm-4.6"], available: true },
      ]);
    }
    if (path.startsWith("/api/chat/sessions")) return json({ id: "session-1", title: "Voice" });
    if (path === "/api/chat") return sse(chatEvents);
    return json({});
  },
}));

// Imported after the stub so the panel picks it up.
const { default: VoicePanel } = await import("./VoicePanel");

/** Ends the fake recording, which hands the panel a finished utterance. */
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
      // Hand the panel a finished utterance as soon as it starts listening.
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
        // Loud enough to count as speech, so the utterance is delivered.
        getByteTimeDomainData: (t: Uint8Array) => t.fill(180),
      };
    }
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    // The panel converts the recording to WAV before upload; happy-dom has no
    // decoder, so hand back a short buffer's worth of silence.
    async decodeAudioData() {
      return {
        numberOfChannels: 1,
        length: 160,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array(160),
      };
    }
    async close() {}
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }),
    },
  });
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

let cleanup: (() => void) | null = null;

afterEach(() => {
  closeStream?.();
  cleanup?.();
  cleanup = null;
  requests.length = 0;
  chatEvents = [];
  transcript = "yes please";
  holdStreamOpen = false;
  localStorage.clear();
});

describe("VoicePanel", () => {
  it("offers the answering model and the speech providers separately", async () => {
    installRecorderFakes();
    const html = await renderToHtml(createElement(VoicePanel));
    expect(html).toContain("Answering model");
    expect(html).toContain("Speech to text");
    expect(html).toContain("Text to speech");
    expect(html).toContain("Ready");
  });

  it("runs a turn: transcribes, asks the agent, and speaks the reply", async () => {
    installRecorderFakes();
    chatEvents = [
      { type: "delta", text: "The build is green and the deploy finished a moment ago. " },
      { type: "done" },
    ];

    const mounted = await mountForInteraction(createElement(VoicePanel));
    cleanup = mounted.unmount;

    const mic = mounted.host.querySelector<HTMLButtonElement>('[aria-label="Start listening"]');
    mic?.click();
    await settle();
    deliverUtterance?.();
    await settle(400);

    const paths = requests.map((r) => r.path);
    expect(paths.some((p) => p.startsWith("/api/voice/transcribe"))).toBe(true);
    expect(paths).toContain("/api/chat");
    // The reply was synthesized, which is the half that makes it a voice loop.
    expect(paths.some((p) => p.startsWith("/api/voice/speak"))).toBe(true);
  });

  it("uploads WAV rather than whatever the browser recorded", async () => {
    installRecorderFakes();
    chatEvents = [{ type: "delta", text: "Done." }, { type: "done" }];

    const mounted = await mountForInteraction(createElement(VoicePanel));
    cleanup = mounted.unmount;

    mounted.host.querySelector<HTMLButtonElement>('[aria-label="Start listening"]')?.click();
    await settle();
    deliverUtterance?.();
    await settle(400);

    // Backends differ in what they can decode — Ollama refuses the AAC the
    // macOS webview records — so the conversion happens before upload.
    const upload = requests.find((r) => r.path.startsWith("/api/voice/transcribe"));
    expect(new Headers(upload?.init?.headers).get("Content-Type")).toBe("audio/wav");
  });

  it("marks the turn as spoken so the agent gates its destructive tools", async () => {
    installRecorderFakes();
    chatEvents = [{ type: "delta", text: "Done." }, { type: "done" }];

    const mounted = await mountForInteraction(createElement(VoicePanel));
    cleanup = mounted.unmount;

    mounted.host.querySelector<HTMLButtonElement>('[aria-label="Start listening"]')?.click();
    await settle();
    deliverUtterance?.();
    await settle(400);

    const chat = requests.find((r) => r.path === "/api/chat");
    expect((chat?.body as { source?: string })?.source).toBe("voice");
    expect((chat?.body as { message?: string })?.message).toBe("yes please");
  });

  it("does not call the agent when nothing intelligible was said", async () => {
    installRecorderFakes();
    transcript = "   ";

    const mounted = await mountForInteraction(createElement(VoicePanel));
    cleanup = mounted.unmount;

    mounted.host.querySelector<HTMLButtonElement>('[aria-label="Start listening"]')?.click();
    await settle();
    deliverUtterance?.();
    await settle(300);

    expect(requests.map((r) => r.path)).not.toContain("/api/chat");
  });

  it("shows an approval prompt while a gated tool waits on the user", async () => {
    installRecorderFakes();
    // The stream stays open, as it does in production while the tool blocks.
    holdStreamOpen = true;
    chatEvents = [
      { type: "delta", text: "Deleting that task. " },
      { type: "tool_approval_request", id: "call-9", name: "delete_task", args: { id: "t-1" } },
    ];

    const mounted = await mountForInteraction(createElement(VoicePanel));
    cleanup = mounted.unmount;

    mounted.host.querySelector<HTMLButtonElement>('[aria-label="Start listening"]')?.click();
    await settle();
    deliverUtterance?.();
    await settle(400);

    // Dropping this event is what used to stall the turn for five minutes and
    // then silently deny it.
    expect(mounted.host.innerHTML).toContain("delete_task");

    closeStream?.();
    await settle();
  });

  it("clears a prompt nobody answered once the turn is over", async () => {
    installRecorderFakes();
    chatEvents = [
      { type: "tool_approval_request", id: "call-9", name: "delete_task", args: {} },
      { type: "done" },
    ];

    const mounted = await mountForInteraction(createElement(VoicePanel));
    cleanup = mounted.unmount;

    mounted.host.querySelector<HTMLButtonElement>('[aria-label="Start listening"]')?.click();
    await settle();
    deliverUtterance?.();
    await settle(400);

    expect(mounted.host.innerHTML).not.toContain("delete_task");
  });
});
