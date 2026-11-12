import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Settings } from "../lib/settings";
import { nativeInvoke } from "../test/nativeInvoke";
import { renderToHtml, waitFor } from "../test/render";

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
    agentHarnesses: null,
    defaultAgentHarness: null,
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
    channelMessaging: null,
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
    if (command === "set_agent_harnesses") {
      const { harnesses, defaultHarness } = args as {
        harnesses: Settings["agentHarnesses"];
        defaultHarness: string | null;
      };
      stored = {
        ...stored,
        agentHarnesses: harnesses?.length ? harnesses : null,
        defaultAgentHarness: defaultHarness === "claude" ? null : defaultHarness,
      };
      return stored;
    }
    if (command === "list_agent_harness_secret_status") {
      return (stored.agentHarnesses ?? []).flatMap((h) =>
        h.secretEnv.map((key) => ({ harnessId: h.id, key, present: false })),
      );
    }
    if (command === "set_agent_harness_secret") return null;
    if (command === "set_channel_messaging") {
      const { enabled } = args as { enabled: boolean };
      stored = { ...stored, channelMessaging: enabled ? true : null };
      return stored;
    }
    if (command === "get_settings" || command === "set_agent") return stored;
    return nativeInvoke(command);
  },
}));

const AgentSection = (await import("./AgentSection")).default;
const { fromDraft, idFor, parseEnv } = await import("./AgentHarnessesField");

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

  it("adds a harness from a preset and saves the list with the default", async () => {
    const { host, cleanup } = await mount();
    const button = (label: string) =>
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
    button("Pi")?.click();
    await waitFor(() => host.innerHTML.includes('value="pi"'));
    button("Save harnesses")?.click();
    await waitFor(() => invoked.some((i) => i.command === "set_agent_harnesses"));

    expect(invoked).toContainEqual({
      command: "set_agent_harnesses",
      args: {
        harnesses: [
          {
            id: "pi",
            name: "Pi",
            kind: "pi",
            command: "pi",
            promptArgs: null,
            env: {},
            secretEnv: [],
            assistantMayUse: false,
          },
        ],
        defaultHarness: "claude",
      },
    });
    cleanup();
  });

  it("falls back to the built-in default when the default harness is removed", async () => {
    stored = {
      ...defaultSettings(),
      agentHarnesses: [
        {
          id: "pi",
          name: "Pi",
          kind: "pi",
          command: "pi",
          promptArgs: null,
          env: {},
          secretEnv: [],
          assistantMayUse: false,
        },
      ],
      defaultAgentHarness: "pi",
    };
    const { host, cleanup } = await mount();
    const button = (label: string) =>
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
    await waitFor(() => button("Remove") !== undefined);
    button("Remove")?.click();
    await waitFor(() => !host.innerHTML.includes('value="pi"'));
    button("Save harnesses")?.click();
    await waitFor(() => invoked.some((i) => i.command === "set_agent_harnesses"));

    expect(invoked).toContainEqual({
      command: "set_agent_harnesses",
      args: { harnesses: [], defaultHarness: "claude" },
    });
    cleanup();
  });

  it("writes a saved harness's secret variable straight to the secret store", async () => {
    stored = {
      ...defaultSettings(),
      agentHarnesses: [
        {
          id: "claude-bedrock",
          name: "Claude (Bedrock)",
          kind: "claude-code",
          command: "claude",
          promptArgs: null,
          env: { CLAUDE_CODE_USE_BEDROCK: "1" },
          secretEnv: ["AWS_BEARER_TOKEN_BEDROCK"],
          assistantMayUse: false,
        },
      ],
    };
    const { host, cleanup } = await mount();
    await waitFor(() => host.innerHTML.includes("AWS_BEARER_TOKEN_BEDROCK"));
    const secret = host.querySelector('input[type="password"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(secret, "tok-123");
    secret.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() =>
      Array.from(host.querySelectorAll("button")).some(
        (b) => b.textContent === "Set" && !b.disabled,
      ),
    );
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "Set")
      ?.click();
    await waitFor(() => invoked.some((i) => i.command === "set_agent_harness_secret"));

    expect(invoked).toContainEqual({
      command: "set_agent_harness_secret",
      args: { harnessId: "claude-bedrock", key: "AWS_BEARER_TOKEN_BEDROCK", value: "tok-123" },
    });
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

  it("drops a stale slash-command notice once that field is edited again", async () => {
    const { host, cleanup } = await mount();
    typeSlash(host, "/do-code-review");
    await clickSaveCommands(host);
    expect(host.innerHTML).toContain("Saved.");

    typeSlash(host, "/do-code-review /simplify");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.innerHTML).not.toContain("Saved.");
    cleanup();
  });

  it("clears a slash-command refusal once a later save succeeds", async () => {
    rejectSaveWith = "/permissions changes what the session may do, so it can't be allowed";
    const { host, cleanup } = await mount();
    typeSlash(host, "/permissions");
    await clickSaveCommands(host);
    expect(host.innerHTML).toContain("so it can't be allowed");

    rejectSaveWith = null;
    await clickSaveCommands(host);
    expect(host.innerHTML).not.toContain("so it can't be allowed");
    expect(host.innerHTML).toContain("Saved.");
    cleanup();
  });

  it("turns channel messaging on and off through the core", async () => {
    const { host, cleanup } = await mount();
    const box = () => host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box().checked).toBe(false);

    box().click();
    await waitFor(() => box().checked && !box().disabled, "the switch to save on");
    expect(invoked).toContainEqual({ command: "set_channel_messaging", args: { enabled: true } });

    box().click();
    await waitFor(() => !box().checked && !box().disabled, "the switch to save off");
    expect(invoked).toContainEqual({ command: "set_channel_messaging", args: { enabled: false } });
    cleanup();
  });

  it("locks a saved harness's id, since its secrets are stored under it", async () => {
    stored = {
      ...defaultSettings(),
      agentHarnesses: [
        {
          id: "pi",
          name: "Pi",
          kind: "pi",
          command: "pi",
          promptArgs: null,
          env: {},
          secretEnv: [],
          assistantMayUse: false,
        },
      ],
    };
    const { host, cleanup } = await mount();
    await waitFor(() => host.innerHTML.includes('value="pi"'));
    const idInput = Array.from(host.querySelectorAll("input")).find((i) => i.value === "pi");
    expect(idInput?.readOnly).toBe(true);
    cleanup();
  });
});

describe("harness draft helpers", () => {
  it("parses KEY=value lines, keeping = in values and a bare name as empty", () => {
    expect(parseEnv("A=1\n\n  B = x=y  \nNAKED\n")).toEqual({ A: "1", B: " x=y", NAKED: "" });
  });

  it("derives a unique id from a name, never the built-in's", () => {
    expect(idFor("Claude (Bedrock)!", [])).toBe("claude-bedrock");
    expect(idFor("Pi", ["pi"])).toBe("pi-2");
    expect(idFor("Pi", ["pi", "pi-2"])).toBe("pi-3");
    expect(idFor("Claude", [])).toBe("claude-2");
    expect(idFor("!!!", [])).toBe("harness");
  });

  it("turns a draft into what the core stores", () => {
    expect(
      fromDraft({
        rowKey: 0,
        savedId: null,
        id: " box ",
        name: " Box ",
        kind: "custom",
        command: " cloudbox run ",
        promptArgs: "  ",
        envText: "A=1",
        secretEnvText: "K1, K2  K3",
        assistantMayUse: true,
      }),
    ).toEqual({
      id: "box",
      name: "Box",
      kind: "custom",
      command: "cloudbox run",
      promptArgs: null,
      env: { A: "1" },
      secretEnv: ["K1", "K2", "K3"],
      assistantMayUse: true,
    });
  });
});
