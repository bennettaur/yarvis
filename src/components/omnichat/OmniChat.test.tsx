import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement, useState } from "react";
import { DEFAULT_VOICE_CONFIG } from "../../lib/voiceConfig";
import { resetChatApi, stubChatApi } from "../../test/chatApi";
import { mountForInteraction, textOf, waitFor } from "../../test/render";
import { realSidecarApi, resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import OmniChat from "./OmniChat";

/**
 * The Omni Chat overlay over a stubbed sidecar. It has its own artifact pane,
 * so a link in its thread must open there rather than in the Chat tab behind it.
 */

const ARTIFACT_ID = "6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const artifact = {
  id: ARTIFACT_ID,
  title: "Launch plan",
  format: "markdown",
  content: "Ship it on Thursday.",
  createdBy: "chat",
  untrusted: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const providers = [
  {
    id: "anthropic",
    label: "Anthropic",
    models: [{ id: "claude-sonnet-5", capabilities: ["chat"] }],
    available: true,
  },
];

/** Events the next turn streams back, in order. */
let scripted: unknown[] = [];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

stubSidecarApi({
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/chat/providers")) return json(providers);
    if (path === "/api/chat/sessions" && init?.method === "POST") {
      return json({
        id: "omni-session",
        title: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }
    if (path.endsWith("/messages")) return json([]);
    if (path === `/api/artifacts/${ARTIFACT_ID}`) return json(artifact);
    if (path === "/api/voice/config") {
      return json({
        ...DEFAULT_VOICE_CONFIG,
        sttProvider: "custom:local",
        sttModel: "whisper",
        continuous: true,
      });
    }
    // A detector that never finishes starting, so the mic stays at "Starting".
    if (path.startsWith("/api/voice/turn-detector")) {
      return json({ state: "starting", url: null, log: [], error: null });
    }
    return new Response("unexpected request", { status: 404 });
  },
  // An open artifact's stream stays quiet until the pane closes.
  streamSSE: async function* (path: string, init: RequestInit = {}) {
    if (!path.startsWith("/api/artifacts/")) {
      yield* realSidecarApi.streamSSE(path, init);
      return;
    }
    yield JSON.stringify({ type: "ping" });
    await new Promise<void>((resolve) =>
      init.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  },
});

mock.module("@tauri-apps/api/core", () => ({ invoke: async () => ({ port: 1, token: "t" }) }));

stubChatApi({
  streamChat: async function* () {
    for (const event of scripted) yield event;
  } as typeof import("../../lib/chat").streamChat,
});

let setOpen: (open: boolean) => void = () => {};
function Host() {
  const [open, setOpenState] = useState(true);
  setOpen = setOpenState;
  return createElement(OmniChat, { open, onClose: () => {}, onAttention: () => {} });
}

const sendButton = (host: HTMLElement) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Send");

async function say(host: HTMLElement, text: string) {
  await waitFor(() => host.querySelector("textarea") !== null, "the composer");
  const box = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set as (
    v: string,
  ) => void;
  setter.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => sendButton(host)?.disabled === false, "Send to be enabled");
  sendButton(host)?.click();
}

const artifactLink = (host: HTMLElement) =>
  Array.from(host.querySelectorAll("a")).find(
    (a) => a.getAttribute("href") === `yarvis://artifact/${ARTIFACT_ID}`,
  );
const paneOf = (host: HTMLElement) => host.querySelector('[aria-label="Artifact: Launch plan"]');

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  scripted = [];
  localStorage.clear();
});

afterAll(() => {
  resetSidecarApi();
  resetChatApi();
});

describe("OmniChat", () => {
  it("opens an artifact its reply links to in its own pane", async () => {
    scripted = [
      { type: "delta", text: `Wrote it up: [Launch plan](yarvis://artifact/${ARTIFACT_ID}).` },
      { type: "done", finishReason: "stop" },
    ];
    const mounted = await mountForInteraction(
      createElement(OmniChat, { open: true, onClose: () => {}, onAttention: () => {} }),
    );
    unmount = mounted.unmount;
    await say(mounted.host, "write a launch plan");

    await waitFor(() => artifactLink(mounted.host) !== undefined, "the reply's artifact link");
    artifactLink(mounted.host)?.click();
    await waitFor(
      () => paneOf(mounted.host)?.textContent?.includes("Ship it on Thursday.") === true,
      "the artifact in the pane",
    );
    expect(textOf(mounted.host.innerHTML)).toContain("Wrote it up");

    paneOf(mounted.host)
      ?.querySelector<HTMLButtonElement>('[aria-label="Close artifact"]')
      ?.click();
    await waitFor(() => paneOf(mounted.host) === null, "the pane to close");
  });

  // The overlay stays mounted while hidden; a continuous mic left open would
  // send what it hears into a chat nobody can see.
  it("closes continuous voice when the overlay is hidden", async () => {
    const mounted = await mountForInteraction(createElement(Host));
    unmount = mounted.unmount;

    mounted.host.querySelector<HTMLButtonElement>('button[aria-label="Start listening"]')?.click();
    await waitFor(
      () => mounted.host.textContent?.includes("Starting turn detection") ?? false,
      "turn detection to start",
    );

    setOpen(false);
    await waitFor(
      () => !mounted.host.textContent?.includes("Starting turn detection"),
      "the mic to close",
    );
  });
});
