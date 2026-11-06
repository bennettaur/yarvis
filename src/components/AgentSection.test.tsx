import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Settings } from "../lib/settings";
import { nativeInvoke } from "../test/nativeInvoke";
import { renderToHtml } from "../test/render";

/**
 * Covers the agent fields end to end through `invoke`, rather than stubbing
 * `lib/settings` — the command name and argument shape are the seam that breaks
 * against the Rust side, and stubbing the module would assert them nowhere.
 */

const invoked: Array<{ command: string; args: unknown }> = [];
let stored: Settings;
/** Error the next `set_agent` rejects with, mimicking the core. */
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
    colorTheme: null,
    terminalFontSize: null,
    attentionAnimation: null,
    allowedSlashCommands: null,
    defaultAllowedSlashCommands: ["compact"],
  };
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args });
    if (command === "set_agent") {
      if (rejectSaveWith) throw new Error(rejectSaveWith);
      const { name, command: cmd } = args as { name: string | null; command: string | null };
      stored = { ...stored, agentName: name, agentCommand: cmd };
    }
    if (command === "set_allowed_slash_commands") {
      if (rejectSaveWith) throw new Error(rejectSaveWith);
      const { commands } = args as { commands: string[] };
      stored = {
        ...stored,
        allowedSlashCommands:
          commands.length > 0 ? commands.map((c) => c.replace(/^\//, "")) : null,
      };
      return stored;
    }
    if (command === "get_settings" || command === "set_agent") return stored;
    return nativeInvoke(command);
  },
}));

const AgentSection = (await import("./AgentSection")).default;

async function mount(): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  root.render(createElement(AgentSection));
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

const typeName = (host: HTMLElement, value: string) => type(host, 0, value);
const typeCommand = (host: HTMLElement, value: string) => type(host, 1, value);

async function clickSave(host: HTMLElement): Promise<void> {
  const button = Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith("Sav"),
  );
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("AgentSection", () => {
  beforeEach(() => {
    invoked.length = 0;
    stored = defaultSettings();
    rejectSaveWith = null;
  });

  it("offers the core's defaults as placeholders when nothing is stored", async () => {
    const html = await renderToHtml(createElement(AgentSection));
    expect(html).toContain('placeholder="Claude"');
    expect(html).toContain('placeholder="claude --permission-mode auto"');
  });

  it("shows stored values as the fields' values", async () => {
    stored = { ...defaultSettings(), agentName: "Codex", agentCommand: "codex --yolo" };
    const html = await renderToHtml(createElement(AgentSection));
    expect(html).toContain('value="Codex"');
    expect(html).toContain('value="codex --yolo"');
  });

  it("sends both fields to the core", async () => {
    const { host, cleanup } = await mount();
    typeName(host, "Codex");
    typeCommand(host, "codex --yolo");
    await clickSave(host);

    expect(invoked).toContainEqual({
      command: "set_agent",
      args: { name: "Codex", command: "codex --yolo" },
    });
    expect(host.innerHTML).toContain("Saved.");
    cleanup();
  });

  it("sends null for a blank field, restoring the default", async () => {
    stored = { ...defaultSettings(), agentName: "Codex", agentCommand: "codex --yolo" };
    const { host, cleanup } = await mount();
    typeName(host, "  ");
    typeCommand(host, "");
    await clickSave(host);

    expect(invoked).toContainEqual({ command: "set_agent", args: { name: null, command: null } });
    cleanup();
  });

  it("surfaces a rejection from the core", async () => {
    rejectSaveWith = "the agent name and command must each be a single line";
    const { host, cleanup } = await mount();
    typeCommand(host, "claude");
    await clickSave(host);

    expect(host.innerHTML).toContain("must each be a single line");
    expect(host.innerHTML).not.toContain("Saved.");
    cleanup();
  });

  it("says so when the env override outranks the stored command", async () => {
    stored = { ...defaultSettings(), agentCommandOverriddenByEnv: true };
    const html = await renderToHtml(createElement(AgentSection));
    expect(html).toContain("takes precedence");
  });

  it("lists the always-allowed slash commands and the stored ones", async () => {
    stored = { ...defaultSettings(), allowedSlashCommands: ["do-code-review"] };
    const html = await renderToHtml(createElement(AgentSection));
    expect(html).toContain("/compact");
    expect(html).toContain('value="/do-code-review"');
  });

  const typeSlash = (host: HTMLElement, value: string) => {
    const index = Array.from(host.querySelectorAll("input")).findIndex(
      (i) => i.placeholder === "/do-code-review",
    );
    type(host, index, value);
  };

  async function clickSaveCommands(host: HTMLElement): Promise<void> {
    const button = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Save commands",
    );
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it("sends the slash commands to the core as a list", async () => {
    const { host, cleanup } = await mount();
    typeSlash(host, "/do-code-review,  /simplify");
    await clickSaveCommands(host);

    expect(invoked).toContainEqual({
      command: "set_allowed_slash_commands",
      args: { commands: ["/do-code-review", "/simplify"] },
    });
    expect(host.innerHTML).toContain("Saved.");
    cleanup();
  });

  it("clears the slash commands with an empty list", async () => {
    stored = { ...defaultSettings(), allowedSlashCommands: ["do-code-review"] };
    const { host, cleanup } = await mount();
    typeSlash(host, "  ");
    await clickSaveCommands(host);

    expect(invoked).toContainEqual({
      command: "set_allowed_slash_commands",
      args: { commands: [] },
    });
    cleanup();
  });

  it("surfaces the core's refusal of a slash command", async () => {
    rejectSaveWith = "/permissions changes what the session may do, so it can't be allowed";
    const { host, cleanup } = await mount();
    typeSlash(host, "/permissions");
    await clickSaveCommands(host);

    expect(host.innerHTML).toContain("so it can't be allowed");
    expect(host.innerHTML).not.toContain("Saved.");
    cleanup();
  });

  it("keeps an unsaved agent command when the slash commands are saved", async () => {
    const { host, cleanup } = await mount();
    typeCommand(host, "codex --yolo");
    typeSlash(host, "/do-code-review");
    await clickSaveCommands(host);

    expect((host.querySelectorAll("input")[1] as HTMLInputElement).value).toBe("codex --yolo");
    cleanup();
  });

  it("keeps an unsaved slash list when the agent fields are saved", async () => {
    const { host, cleanup } = await mount();
    typeSlash(host, "/do-code-review");
    typeName(host, "Codex");
    await clickSave(host);

    const slash = Array.from(host.querySelectorAll("input")).find(
      (i) => i.placeholder === "/do-code-review",
    );
    expect(slash?.value).toBe("/do-code-review");
    cleanup();
  });

  it("drops a stale save notice once a field is edited again", async () => {
    const { host, cleanup } = await mount();
    typeName(host, "Codex");
    await clickSave(host);
    expect(host.innerHTML).toContain("Saved.");

    typeName(host, "Codex2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.innerHTML).not.toContain("Saved.");
    cleanup();
  });
});
