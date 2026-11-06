import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { createLevelMeter } from "../../lib/levelMeter";
import type { UseVoiceResult } from "../../lib/useVoice";
import { DEFAULT_VOICE_CONFIG } from "../../lib/voiceConfig";
import { renderToHtml, textOf } from "../../test/render";
import VoiceControls from "./VoiceControls";

function voice(overrides: Partial<UseVoiceResult> = {}): UseVoiceResult {
  return {
    config: { ...DEFAULT_VOICE_CONFIG },
    updateConfig: async () => {},
    ready: { stt: true, tts: true },
    recording: false,
    starting: false,
    hearing: false,
    queued: 0,
    level: createLevelMeter(),
    phase: "idle",
    error: null,
    startListening: () => {},
    stopListening: () => {},
    cancel: () => {},
    ...overrides,
  };
}

async function render(state: UseVoiceResult) {
  const html = await renderToHtml(createElement(VoiceControls, { voice: state }), 10);
  const host = document.createElement("div");
  host.innerHTML = html;
  return {
    text: textOf(html),
    mic: host.querySelector("button[aria-label]") as HTMLButtonElement,
    stop: [...host.querySelectorAll("button")].find((b) => b.textContent === "Stop"),
  };
}

describe("VoiceControls", () => {
  it("offers Stop while turn detection is still starting", async () => {
    const { text, stop } = await render(voice({ starting: true }));
    expect(text).toContain("Starting turn detection…");
    expect(stop).toBeDefined();
  });

  it("offers no Stop when nothing is in progress", async () => {
    const { stop } = await render(voice());
    expect(stop).toBeUndefined();
  });

  it("shows how many turns are waiting for the reply to end", async () => {
    expect((await render(voice({ queued: 2 }))).text).toContain("2 queued");
    expect((await render(voice({ queued: 0 }))).text).not.toContain("queued");
  });

  it("keeps the mic usable while transcribing in continuous mode only", async () => {
    const continuous = await render(
      voice({
        phase: "transcribing",
        recording: true,
        config: { ...DEFAULT_VOICE_CONFIG, continuous: true },
      }),
    );
    expect(continuous.mic.disabled).toBe(false);
    expect(continuous.text).toContain("Transcribing…");

    const pushToTalk = await render(voice({ phase: "transcribing" }));
    expect(pushToTalk.mic.disabled).toBe(true);
  });

  it("says when it hears the user", async () => {
    expect((await render(voice({ recording: true, hearing: true }))).text).toContain(
      "Hearing you…",
    );
    expect((await render(voice({ recording: true }))).text).toContain("Listening…");
  });
});
