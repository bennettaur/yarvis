import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement, useState } from "react";
import { DEFAULT_VOICE_CONFIG } from "../../lib/voiceConfig";
import { mountForInteraction } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import OmniChat from "./OmniChat";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

stubSidecarApi({
  sidecarFetch: async (path: string) => {
    if (path.startsWith("/api/chat/providers")) return json([]);
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
});

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

let setOpen: (open: boolean) => void = () => {};
function Host() {
  const [open, setOpenState] = useState(true);
  setOpen = setOpenState;
  return createElement(OmniChat, { open, onClose: () => {}, onAttention: () => {} });
}

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  localStorage.clear();
});

afterAll(() => resetSidecarApi());

describe("OmniChat", () => {
  // The overlay stays mounted while hidden; a continuous mic left open would
  // send what it hears into a chat nobody can see.
  it("closes continuous voice when the overlay is hidden", async () => {
    const mounted = await mountForInteraction(createElement(Host));
    unmount = mounted.unmount;

    mounted.host.querySelector<HTMLButtonElement>('button[aria-label="Start listening"]')?.click();
    await settle();
    expect(mounted.host.textContent).toContain("Starting turn detection");

    setOpen(false);
    await settle();
    expect(mounted.host.textContent).not.toContain("Starting turn detection");
  });
});
