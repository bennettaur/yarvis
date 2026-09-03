import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Settings } from "../lib/settings";
import { nativeInvoke } from "../test/nativeInvoke";
import { renderToHtml } from "../test/render";

/**
 * Covers the four settings fields end to end through `invoke`, rather than
 * stubbing `lib/settings` — the command name and argument shape are the seam
 * that breaks against the Rust side, and stubbing the module would assert
 * them nowhere. `lib/api` is stubbed instead, since saving here also restarts
 * the sidecar and waits for it to come back — real network calls have no
 * place in a unit test.
 */

const invoked: Array<{ command: string; args: unknown }> = [];
let stored: Settings;

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

const SET_COMMANDS: Record<string, keyof Settings> = {
  set_azure_devops_org_url: "azureDevopsOrgUrl",
  set_jira_base_url: "jiraBaseUrl",
  set_jira_email: "jiraEmail",
  set_google_client_id: "googleClientId",
};

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args });
    const field = SET_COMMANDS[command];
    if (field) {
      const { value } = args as { value: string | null };
      stored = { ...stored, [field]: value };
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

const IntegrationSettingsSection = (await import("./IntegrationSettingsSection")).default;

async function mount(): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  root.render(createElement(IntegrationSettingsSection));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    host,
    cleanup: () => {
      root.unmount();
      host.remove();
    },
  };
}

/** Types into one of the text fields. Goes through the prototype's value setter
 * because React's own value tracker swallows the change event when the property
 * is assigned directly. */
function type(host: HTMLElement, index: number, value: string): void {
  const input = host.querySelectorAll("input")[index] as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clickSave(host: HTMLElement, index: number): Promise<void> {
  const button = host.querySelectorAll("button")[index] as HTMLButtonElement;
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("IntegrationSettingsSection", () => {
  beforeEach(() => {
    invoked.length = 0;
    stored = defaultSettings();
  });

  it("shows stored values as the fields' values", async () => {
    stored = {
      ...defaultSettings(),
      azureDevopsOrgUrl: "https://dev.azure.com/acme",
      jiraEmail: "dev@acme.com",
    };
    const html = await renderToHtml(createElement(IntegrationSettingsSection));
    expect(html).toContain('value="https://dev.azure.com/acme"');
    expect(html).toContain('value="dev@acme.com"');
  });

  it("sends a field to the core and restarts the sidecar", async () => {
    const { host, cleanup } = await mount();
    type(host, 0, "https://dev.azure.com/acme");
    await clickSave(host, 0);

    expect(invoked).toContainEqual({
      command: "set_azure_devops_org_url",
      args: { value: "https://dev.azure.com/acme" },
    });
    expect(invoked.map((c) => c.command)).toContain("restart_sidecar");
    cleanup();
  });

  it("sends null for a blank field, clearing it", async () => {
    stored = { ...defaultSettings(), jiraBaseUrl: "https://acme.atlassian.net" };
    const { host, cleanup } = await mount();
    type(host, 1, "   ");
    await clickSave(host, 1);

    expect(invoked).toContainEqual({ command: "set_jira_base_url", args: { value: null } });
    cleanup();
  });

  it("saves each field independently", async () => {
    const { host, cleanup } = await mount();
    type(host, 2, "dev@acme.com");
    await clickSave(host, 2);
    type(host, 3, "abc.apps.googleusercontent.com");
    await clickSave(host, 3);

    expect(invoked).toContainEqual({
      command: "set_jira_email",
      args: { value: "dev@acme.com" },
    });
    expect(invoked).toContainEqual({
      command: "set_google_client_id",
      args: { value: "abc.apps.googleusercontent.com" },
    });
    cleanup();
  });
});
