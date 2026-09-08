import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Settings } from "../lib/settings";
import { nativeInvoke } from "../test/nativeInvoke";
import { renderToHtml } from "../test/render";

/**
 * Covers the backend switch end to end through `invoke` rather than stubbing
 * `lib/settings` — the command name and argument shape are the seam that
 * breaks against the Rust side. `lib/api` is stubbed because saving also
 * restarts the sidecar and waits for it to come back.
 */

const invoked: Array<{ command: string; args: unknown }> = [];
let stored: Settings;
/** Error the next `set_secret_backend` rejects with, mimicking an unreachable
 * 1Password. */
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
    secretBackend: null,
    onePasswordVault: null,
    onePasswordItem: null,
  };
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args });
    if (command === "set_secret_backend") {
      if (rejectSaveWith) throw new Error(rejectSaveWith);
      const { backend, vault, item } = args as {
        backend: string;
        vault: string | null;
        item: string | null;
      };
      stored = {
        ...stored,
        secretBackend: backend === "onepassword" ? "onepassword" : null,
        onePasswordVault: vault ?? stored.onePasswordVault,
        onePasswordItem: item ?? stored.onePasswordItem,
      };
      return stored;
    }
    if (command === "get_settings") return stored;
    if (command === "restart_sidecar") return undefined;
    return nativeInvoke(command);
  },
}));

mock.module("../lib/api", () => ({
  getHealth: async () => ({ ready: true, uptimeMs: 1000 }),
  waitForSidecarReady: async () => {},
}));

const SecretBackendSection = (await import("./SecretBackendSection")).default;

async function mount(): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  root.render(createElement(SecretBackendSection));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    host,
    cleanup: () => {
      root.unmount();
      host.remove();
    },
  };
}

/** Picks one of the backend radios by its value. */
function choose(host: HTMLElement, value: string): void {
  const radio = host.querySelector(`input[value="${value}"]`) as HTMLInputElement;
  radio.click();
}

/** Types into a text field, going through the prototype's value setter because
 * React's own value tracker swallows the change event otherwise. */
function type(host: HTMLElement, id: string, value: string): void {
  const input = host.querySelector(`#${id}`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clickSave(host: HTMLElement): Promise<void> {
  (host.querySelector("button") as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("SecretBackendSection", () => {
  beforeEach(() => {
    invoked.length = 0;
    rejectSaveWith = null;
    stored = defaultSettings();
  });

  it("reports the Keychain while no backend is stored", async () => {
    const html = await renderToHtml(createElement(SecretBackendSection));
    expect(html).toContain("In use: macOS Keychain");
  });

  it("shows the stored vault and item once 1Password is selected", async () => {
    stored = {
      ...defaultSettings(),
      secretBackend: "onepassword",
      onePasswordVault: "Private",
      onePasswordItem: "Yarvis Secrets",
    };
    const html = await renderToHtml(createElement(SecretBackendSection));
    expect(html).toContain("In use: 1Password");
    expect(html).toContain('value="Private"');
    expect(html).toContain('value="Yarvis Secrets"');
  });

  it("sends the vault and item to the core and restarts the sidecar", async () => {
    const { host, cleanup } = await mount();
    choose(host, "onepassword");
    await new Promise((resolve) => setTimeout(resolve, 10));
    type(host, "op-vault", "Private");
    type(host, "op-item", "Yarvis Secrets");
    await clickSave(host);

    expect(invoked).toContainEqual({
      command: "set_secret_backend",
      args: { backend: "onepassword", vault: "Private", item: "Yarvis Secrets" },
    });
    expect(invoked.map((c) => c.command)).toContain("restart_sidecar");
    cleanup();
  });

  it("leaves the store unchanged and shows why when the switch is refused", async () => {
    rejectSaveWith = "1Password has no vault named 'Typo'";
    const { host, cleanup } = await mount();
    choose(host, "onepassword");
    await new Promise((resolve) => setTimeout(resolve, 10));
    type(host, "op-vault", "Typo");
    type(host, "op-item", "Yarvis Secrets");
    await clickSave(host);

    expect(host.textContent).toContain("1Password has no vault named 'Typo'");
    expect(host.textContent).toContain("In use: macOS Keychain");
    expect(invoked.map((c) => c.command)).not.toContain("restart_sidecar");
    cleanup();
  });

  it("switches back to the Keychain without needing the vault fields", async () => {
    stored = {
      ...defaultSettings(),
      secretBackend: "onepassword",
      onePasswordVault: "Private",
      onePasswordItem: "Yarvis Secrets",
    };
    const { host, cleanup } = await mount();
    choose(host, "keychain");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await clickSave(host);

    expect(invoked).toContainEqual({
      command: "set_secret_backend",
      args: { backend: "keychain", vault: "Private", item: "Yarvis Secrets" },
    });
    cleanup();
  });
});
