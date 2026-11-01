import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { clearResourceCache } from "../../lib/resourceCache";
import type { SpeechServerStatus } from "../../lib/speechServer";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "../../lib/voiceConfig";
import type { VoiceProfile } from "../../lib/voiceProfiles";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import SpeechServerSection from "./SpeechServerSection";
import VoicePanel from "./VoicePanel";
import VoiceStudio from "./VoiceStudio";

const NARRATOR: VoiceProfile = {
  id: "0b5f3c8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f",
  name: "Narrator",
  provider: "gemini",
  model: "tts-model",
  voice: "",
  hasClip: false,
  refAudioMode: "path",
  extras: {},
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
};

/** What the fake sidecar holds; each test sets its own. */
let config: VoiceConfig;
/** When set, saving the voice config fails with this status. */
let configSaveStatus: number | null = null;
let voices: VoiceProfile[];
let server: SpeechServerStatus;
const requests: { method: string; path: string; body: unknown }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers the Voice page's requests from the state above, recording each one. */
async function fakeSidecar(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  requests.push({ method, path, body });
  if (path === "/api/voice/config") {
    if (method === "PATCH") {
      if (configSaveStatus) return json({ error: "settings are read-only" }, configSaveStatus);
      config = { ...config, ...body };
    }
    return json(config);
  }
  if (path === "/api/voice/voices") return json(voices);
  const voice = /^\/api\/voice\/voices\/([^/]+)$/.exec(path);
  if (voice && method === "DELETE") {
    // The real route also clears the active voice; this one leaves that to the
    // page, so the test sees what the page itself does.
    voices = voices.filter((v) => v.id !== voice[1]);
    return json(null, 204);
  }
  if (path === "/api/voice/server") return json(server);
  if (path === "/api/voice/server/models") return json([]);
  if (path === "/api/voice/studio/takes") return json([]);
  return json([]);
}

function stoppedServer(): SpeechServerStatus {
  return {
    state: "stopped",
    owner: null,
    port: 8000,
    baseUrl: "http://127.0.0.1:8000/v1",
    log: [],
    error: null,
  };
}

function button(host: HTMLElement, label: string, within?: string): HTMLButtonElement {
  const scope = within
    ? [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(within))
    : host;
  const found = [...(scope?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found as HTMLButtonElement;
}

function type(field: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  clearResourceCache();
  config = { ...DEFAULT_VOICE_CONFIG };
  voices = [NARRATOR];
  server = stoppedServer();
  configSaveStatus = null;
  requests.length = 0;
  stubSidecarApi({ sidecarFetch: fakeSidecar });
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

afterAll(() => {
  resetSidecarApi();
  clearResourceCache();
});

describe("Voices section", () => {
  it("activates a saved voice so replies are spoken in it", async () => {
    const mounted = await mountForInteraction(createElement(VoicePanel));
    unmount = mounted.unmount;
    expect(mounted.host.textContent).not.toContain("Active");

    button(mounted.host, "Activate", "Narrator").click();
    await waitFor(() => mounted.host.textContent?.includes("Deactivate") ?? false, "Deactivate");

    expect(requests).toContainEqual({
      method: "PATCH",
      path: "/api/voice/config",
      body: { activeVoiceId: NARRATOR.id },
    });
    expect(mounted.host.textContent).toContain("Active");
  });

  it("clears the active voice when that voice is deleted", async () => {
    config = { ...config, activeVoiceId: NARRATOR.id };
    const mounted = await mountForInteraction(createElement(VoicePanel));
    unmount = mounted.unmount;
    expect(mounted.host.textContent).toContain("Active");

    button(mounted.host, "Delete", "Narrator").click();
    await waitFor(
      () => mounted.host.textContent?.includes("No saved voices yet.") ?? false,
      "the empty list",
    );

    expect(requests.some((r) => r.method === "DELETE")).toBe(true);
    await waitFor(() => config.activeVoiceId === "", "the page to clear the active voice");
  });

  it("says so when activating a voice can't be saved", async () => {
    configSaveStatus = 500;
    const mounted = await mountForInteraction(createElement(VoicePanel));
    unmount = mounted.unmount;

    button(mounted.host, "Activate", "Narrator").click();
    await waitFor(
      () => mounted.host.textContent?.includes("settings are read-only") ?? false,
      "the save error",
    );
    expect(mounted.host.textContent).not.toContain("Deactivate");
  });
});

describe("Studio", () => {
  async function mountStudio() {
    const mounted = await mountForInteraction(
      createElement(VoiceStudio, {
        voices,
        takes: [],
        chatProviders: [],
        config,
        onConfigChange: async () => {},
      }),
    );
    unmount = mounted.unmount;
    return mounted;
  }

  it("enables Generate only with text and at least one voice ticked", async () => {
    const { host } = await mountStudio();
    const generate = button(host, "Generate");
    expect(generate.disabled).toBe(true);

    type(host.querySelector("textarea") as HTMLTextAreaElement, "Your build finished.");
    await waitFor(() => !generate.disabled, "Generate to enable");

    for (const box of host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
      if (box.checked) box.click();
    }
    await waitFor(() => generate.disabled, "Generate to disable with no voice ticked");
  });
});

describe("Speech server section", () => {
  async function serverReadsOver(ms: number): Promise<number> {
    const mounted = await mountForInteraction(
      createElement(SpeechServerSection, { onProviderReady: () => {} }),
    );
    unmount = mounted.unmount;
    const before = requests.filter((r) => r.path === "/api/voice/server").length;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return requests.filter((r) => r.path === "/api/voice/server").length - before;
  }

  // One poll interval (2 s) plus room for a slow runner.
  const POLL_WINDOW_MS = 2_800;

  it("polls the status while the server is starting", async () => {
    server = { ...stoppedServer(), state: "starting" };
    expect(await serverReadsOver(POLL_WINDOW_MS)).toBeGreaterThan(0);
  });

  it("doesn't poll a server that isn't changing", async () => {
    expect(await serverReadsOver(POLL_WINDOW_MS)).toBe(0);
  });

  async function mountServer() {
    const mounted = await mountForInteraction(
      createElement(SpeechServerSection, { onProviderReady: () => {} }),
    );
    unmount = mounted.unmount;
    return mounted.host;
  }

  it("offers Stop and Use for voice for the server this instance runs, and locks the port", async () => {
    server = { ...stoppedServer(), state: "running" };
    const host = await mountServer();
    expect(button(host, "Stop").disabled).toBe(false);
    expect(() => button(host, "Start")).toThrow();
    expect(button(host, "Use for voice").disabled).toBe(false);
    expect((host.querySelector("input") as HTMLInputElement).disabled).toBe(true);
  });

  it("uses an mlx-audio server the user started, without offering to stop it", async () => {
    server = { ...stoppedServer(), state: "external" };
    const host = await mountServer();
    expect(host.textContent).toContain("Running (started elsewhere)");
    expect(button(host, "Use for voice").disabled).toBe(false);
    expect(() => button(host, "Stop")).toThrow();
  });

  it("won't use a port another program answers on", async () => {
    server = { ...stoppedServer(), state: "occupied" };
    const host = await mountServer();
    expect(host.textContent).toContain("Port in use");
    expect(button(host, "Start").disabled).toBe(true);
    expect(button(host, "Use for voice").disabled).toBe(true);
  });

  it("names the instance that started a server it can't stop", async () => {
    server = { ...stoppedServer(), state: "external", owner: "work" };
    const mounted = await mountForInteraction(
      createElement(SpeechServerSection, { onProviderReady: () => {} }),
    );
    unmount = mounted.unmount;
    expect(mounted.host.textContent).toContain("started by the work instance");
    expect(button(mounted.host, "Start").disabled).toBe(true);
  });
});
