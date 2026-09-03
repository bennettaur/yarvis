import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Settings } from "../lib/settings";
import { nativeInvoke } from "../test/nativeInvoke";
import { renderToHtml } from "../test/render";

/**
 * Covers the session-limit field end to end through `invoke`, rather than
 * stubbing `lib/settings` — the command names and argument shape are the seam
 * that breaks against the Rust side, and stubbing the module would assert them
 * nowhere.
 */

const invoked: Array<{ command: string; args: unknown }> = [];
let stored: Settings;
/** Error the next `set_max_pty_sessions` rejects with, mimicking the core. */
let rejectSaveWith: string | null = null;

function defaultSettings(): Settings {
  return {
    maxPtySessions: null,
    defaultMaxPtySessions: 60,
    maxConfigurablePtySessions: 1000,
    agentName: null,
    agentCommand: null,
    defaultAgentName: "Claude",
    defaultAgentCommand: "claude --permission-mode auto",
    agentCommandOverriddenByEnv: false,
    azureDevopsOrgUrl: null,
    jiraBaseUrl: null,
    jiraEmail: null,
    googleClientId: null,
    telegramOtpWindowMinutes: null,
    defaultTelegramOtpWindowMinutes: 120,
  };
}

// mock.module replaces the module for the whole run — including for suites that
// run after this one — so anything this file doesn't handle goes to the shared
// defaults rather than answering `undefined`.
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args });
    if (command === "set_max_pty_sessions") {
      if (rejectSaveWith) throw new Error(rejectSaveWith);
      stored = { ...stored, maxPtySessions: (args as { value: number | null }).value };
    }
    if (command === "get_settings" || command === "set_max_pty_sessions") return stored;
    return nativeInvoke(command);
  },
}));

const TerminalSection = (await import("./TerminalSection")).default;

/** Mounts and settles, returning the live host so a test can drive the field
 * and the Save button. `renderToHtml` unmounts before it returns. */
async function mount(): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  root.render(createElement(TerminalSection));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    host,
    cleanup: () => {
      root.unmount();
      host.remove();
    },
  };
}

/** Types into the number field. Goes through the prototype's value setter
 * because React's own value tracker swallows the change event when the property
 * is assigned directly. */
function type(host: HTMLElement, value: string): void {
  const input = host.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clickSave(host: HTMLElement): Promise<void> {
  const button = Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith("Sav"),
  );
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("TerminalSection", () => {
  beforeEach(() => {
    invoked.length = 0;
    stored = defaultSettings();
    rejectSaveWith = null;
  });

  it("offers the core's default as the placeholder when no cap is stored", async () => {
    const html = await renderToHtml(createElement(TerminalSection));
    expect(html).toContain('placeholder="60"');
    expect(html).toContain("Blank uses the default of 60.");
  });

  it("shows a stored cap as the field's value", async () => {
    stored = { ...defaultSettings(), maxPtySessions: 120 };
    const html = await renderToHtml(createElement(TerminalSection));
    expect(html).toContain('value="120"');
  });

  it("sends a typed cap to the core", async () => {
    const { host, cleanup } = await mount();
    type(host, "120");
    await clickSave(host);

    expect(invoked).toContainEqual({ command: "set_max_pty_sessions", args: { value: 120 } });
    expect(host.innerHTML).toContain("Saved.");
    cleanup();
  });

  it("sends null for a blank field, restoring the default", async () => {
    stored = { ...defaultSettings(), maxPtySessions: 120 };
    const { host, cleanup } = await mount();
    type(host, "");
    await clickSave(host);

    expect(invoked).toContainEqual({ command: "set_max_pty_sessions", args: { value: null } });
    cleanup();
  });

  it("rejects a cap below 1 without calling the core", async () => {
    const { host, cleanup } = await mount();
    type(host, "0");
    await clickSave(host);

    expect(invoked.some((c) => c.command === "set_max_pty_sessions")).toBe(false);
    expect(host.innerHTML).toContain("whole number of 1 or more");
    cleanup();
  });

  it("rejects a fractional cap without calling the core", async () => {
    const { host, cleanup } = await mount();
    type(host, "1.5");
    await clickSave(host);

    expect(invoked.some((c) => c.command === "set_max_pty_sessions")).toBe(false);
    cleanup();
  });

  it("rejects a cap above the core's ceiling without calling it", async () => {
    const { host, cleanup } = await mount();
    type(host, "1001");
    await clickSave(host);

    expect(invoked.some((c) => c.command === "set_max_pty_sessions")).toBe(false);
    expect(host.innerHTML).toContain("highest supported limit is 1000");
    cleanup();
  });

  it("surfaces a rejection from the core", async () => {
    rejectSaveWith = "the session cap must be at least 1";
    const { host, cleanup } = await mount();
    type(host, "5");
    await clickSave(host);

    expect(host.innerHTML).toContain("the session cap must be at least 1");
    expect(host.innerHTML).not.toContain("Saved.");
    cleanup();
  });

  it("drops a stale save notice once the field is edited again", async () => {
    const { host, cleanup } = await mount();
    type(host, "120");
    await clickSave(host);
    expect(host.innerHTML).toContain("Saved.");

    type(host, "121");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.innerHTML).not.toContain("Saved.");
    cleanup();
  });
});
