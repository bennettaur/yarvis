import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as realChat from "../../lib/chat";
import { mountForInteraction, textOf } from "../../test/render";
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

mock.module("../../lib/chat", () => ({
  ...realChat,
  streamChat: async function* () {
    for (const event of scripted) yield event;
  },
}));

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function say(host: HTMLElement, text: string) {
  const box = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set as (
    v: string,
  ) => void;
  setter.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await settle(20);
  Array.from(host.querySelectorAll("button"))
    .find((b) => b.textContent === "Send")
    ?.click();
  await settle();
}

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  scripted = [];
  localStorage.clear();
});

afterAll(() => {
  resetSidecarApi();
  mock.module("../../lib/chat", () => realChat);
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
    await settle();
    await say(mounted.host, "write a launch plan");

    Array.from(mounted.host.querySelectorAll("a"))
      .find((a) => a.getAttribute("href") === `yarvis://artifact/${ARTIFACT_ID}`)
      ?.click();
    await settle();
    const pane = mounted.host.querySelector('[aria-label="Artifact: Launch plan"]');
    expect(pane?.textContent).toContain("Ship it on Thursday.");
    expect(textOf(mounted.host.innerHTML)).toContain("Wrote it up");

    pane?.querySelector<HTMLButtonElement>('[aria-label="Close artifact"]')?.click();
    await settle();
    expect(mounted.host.querySelector('[aria-label="Artifact: Launch plan"]')).toBeNull();
  });
});
