/**
 * Stands in for the Rust core so the real frontend runs in a plain browser.
 *
 * Every `invoke` the UI makes is answered here, and `listen` is backed by
 * Tauri's own event mock so a demo can fire native events (an alarm going
 * off, the Quick Chat hotkey) with `window.__yarvisDemoControls.emit`. Data
 * still comes from a real sidecar; only the native layer is faked.
 *
 * The sidecar's port and token arrive on `window.__YARVIS_DEMO_CONFIG__`,
 * which the Playwright fixture sets before any page script runs.
 */

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Alarm } from "../src/lib/alarms";
import type { ClipboardHistoryItem } from "../src/lib/clipboard";
import type { Settings } from "../src/lib/settings";
import { type DemoConfig, UNMOCKED_COMMAND_WARNING } from "./demoConfig";
import { SITE_URL as JIRA_SITE_URL, VIEWER as JIRA_VIEWER } from "./fakeJira/data";
import { FakeTerminals } from "./fakeShell";

declare global {
  interface Window {
    __YARVIS_DEMO_CONFIG__?: DemoConfig;
    __yarvisDemoControls?: {
      emit: typeof emit;
      fireAlarm: (alarm: Omit<Alarm, "status">) => Promise<void>;
      /** What the app last put on the clipboard, for a flow to paste. */
      clipboardText: () => string;
    };
  }
}

function readConfig(): DemoConfig {
  const config = window.__YARVIS_DEMO_CONFIG__;
  if (!config) {
    throw new Error(
      "demo/index.html needs window.__YARVIS_DEMO_CONFIG__; open it through `bun run demo`",
    );
  }
  return config;
}

const config = readConfig();

// Mirrors SECRET_KEYS in src-tauri/src/keychain.rs, so Settings lists the
// same rows as the real app.
const SECRET_KEYS = [
  "anthropic_api_key",
  "gemini_api_key",
  "cerebras_api_key",
  "huggingface_api_key",
  "github_token",
  "azure_devops_token",
  "jira_api_token",
  "database_url",
  "google_client_secret",
  "telegram_bot_token",
  "telegram_allowed_chat_ids",
  "telegram_otp_secret",
];

// Mirrors the defaults in src-tauri/src/settings.rs and pty.rs.
let settings: Settings = {
  maxPtySessions: null,
  defaultMaxPtySessions: 60,
  maxConfigurablePtySessions: 1000,
  agentName: null,
  agentCommand: null,
  defaultAgentName: "Claude",
  defaultAgentCommand: "claude --permission-mode auto",
  agentCommandOverriddenByEnv: false,
  azureDevopsOrgUrl: null,
  // What the sidecar was started with (demo/stack.ts), so Settings agrees.
  jiraBaseUrl: JIRA_SITE_URL,
  jiraEmail: JIRA_VIEWER.emailAddress,
  googleClientId: config.googleClientId,
  telegramOtpWindowMinutes: null,
  defaultTelegramOtpWindowMinutes: 120,
  secretBackend: null,
  onePasswordVault: null,
  onePasswordItem: null,
};

const presentSecrets = new Set(config.presentSecrets);
let alarms: Alarm[] = [];
// What the core's clipboard poller would have recorded, newest first.
let clipboardHistory: ClipboardHistoryItem[] = [
  { text: "bun test tests/checkout", minutesAgo: 3 },
  { text: "https://github.com/acme/checkout-web/pull/477", minutesAgo: 12 },
  { text: "Saved cards now load before the new-card form", minutesAgo: 26 },
  { text: "usePaymentIntent", minutesAgo: 41 },
].map(({ text, minutesAgo }, i) => ({
  id: `clip-${i}`,
  text,
  capturedAtMs: Date.now() - minutesAgo * 60_000,
}));

type CommandArgs = Record<string, unknown>;

// The core's PTYs, played by scripted shells.
const terminals = new FakeTerminals((id, chunk) => void emit(`pty-output:${id}`, chunk));

function updateSettings(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch };
  return settings;
}

function updateAlarm(id: string, patch: Partial<Alarm>): void {
  alarms = alarms.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

/**
 * Fires an alarm the way the core's scheduler does: the alarm is marked fired
 * in the list first, because the app re-reads that list as soon as the event
 * lands and drops anything it doesn't find there.
 */
async function fireAlarm(alarm: Omit<Alarm, "status">): Promise<void> {
  const fired: Alarm = { ...alarm, status: "fired" };
  alarms = [...alarms.filter((a) => a.id !== alarm.id), fired];
  await emit("alarm-fired", fired);
}

function handleCommand(cmd: string, args: CommandArgs): unknown {
  switch (cmd) {
    case "get_sidecar_info":
      return { port: config.sidecarPort, token: config.sidecarToken };
    case "get_sidecar_log_path":
      return "~/Library/Logs/Yarvis/sidecar.log";
    case "restart_sidecar":
    case "focus_main_window":
      return null;

    case "get_settings":
      return settings;
    case "set_max_pty_sessions":
      return updateSettings({ maxPtySessions: args.value as number | null });
    case "set_agent":
      // The core stores a blank field as unset.
      return updateSettings({
        agentName: (args.name as string | null) || null,
        agentCommand: (args.command as string | null) || null,
      });
    case "set_azure_devops_org_url":
      return updateSettings({ azureDevopsOrgUrl: args.value as string | null });
    case "set_jira_base_url":
      return updateSettings({ jiraBaseUrl: args.value as string | null });
    case "set_jira_email":
      return updateSettings({ jiraEmail: args.value as string | null });
    case "set_google_client_id":
      return updateSettings({ googleClientId: args.value as string | null });
    case "set_telegram_otp_window_minutes":
      return updateSettings({ telegramOtpWindowMinutes: args.value as number | null });
    case "set_secret_backend":
      return {
        settings: updateSettings({
          secretBackend: args.backend as Settings["secretBackend"],
          onePasswordVault: args.vault as string | null,
          onePasswordItem: args.item as string | null,
        }),
        copied: "unchanged",
      };

    case "list_secret_status":
      return SECRET_KEYS.map((key) => ({ key, present: presentSecrets.has(key) }));
    case "set_secret":
      presentSecrets.add(args.key as string);
      return null;
    case "delete_secret":
      presentSecrets.delete(args.key as string);
      return null;
    case "list_custom_provider_secret_status":
    case "list_mcp_secret_status":
      return [];
    case "get_embeddings_secret_status":
      return { apiKeyPresent: false, headers: {} };
    case "set_custom_provider_secret":
    case "delete_custom_provider_secret":
    case "delete_custom_provider_all_secrets":
    case "set_mcp_secret":
    case "delete_mcp_secret":
    case "delete_mcp_all_secrets":
    case "set_embeddings_secret":
    case "delete_embeddings_secret":
      return null;

    case "list_alarms":
      return alarms;
    case "create_alarm": {
      const alarm: Alarm = {
        id: crypto.randomUUID(),
        label: args.label as string,
        fireAtMs: args.fireAtMs as number,
        sound: args.sound as boolean,
        meetLink: (args.meetLink as string | null) ?? null,
        status: "scheduled",
      };
      alarms = [...alarms, alarm];
      return alarm;
    }
    case "cancel_alarm":
      updateAlarm(args.id as string, { status: "cancelled" });
      return null;
    case "acknowledge_alarm":
      updateAlarm(args.id as string, { status: "acknowledged" });
      return null;
    case "snooze_alarm":
      updateAlarm(args.id as string, {
        status: "scheduled",
        fireAtMs: Date.now() + (args.minutes as number) * 60_000,
      });
      return null;

    case "clipboard_history":
      return clipboardHistory;
    case "clipboard_clear_history":
      clipboardHistory = [];
      return null;
    // The core's poller puts the app's own copies at the front of history too.
    case "clipboard_write":
      clipboardHistory = [
        { id: crypto.randomUUID(), text: args.text as string, capturedAtMs: Date.now() },
        ...clipboardHistory.filter((item) => item.text !== args.text),
      ];
      return null;

    case "get_agent_config":
      return {
        name: settings.agentName ?? settings.defaultAgentName,
        command: settings.agentCommand ?? settings.defaultAgentCommand,
      };
    case "pty_exists":
      return terminals.exists(args.id as string);
    // Never busy, so closing a tab doesn't stop the recording on a confirm dialog.
    case "pty_is_busy":
      return false;
    case "pty_attach":
      return terminals.attach(args.id as string);
    case "pty_write":
      terminals.write(args.id as string, args.data as string);
      return null;
    case "pty_kill":
      terminals.kill(args.id as string);
      return null;
    case "pty_start_claude":
      terminals.startAgent(args.workspaceId as string);
      return null;
    case "pty_resize":
      return null;

    case "plugin:opener|open_url":
      return null;
    // Asked only while the browser's own permission is undecided. Saying no
    // keeps notifications from popping up over a recording.
    case "plugin:notification|is_permission_granted":
      return false;

    default:
      // The fixture fails the flow on this line, so a command the app gains
      // later shows up as a failure rather than a quietly broken screenshot.
      // Arguments are left out because some commands carry secrets.
      console.warn(`${UNMOCKED_COMMAND_WARNING} ${cmd}`);
      return null;
  }
}

mockIPC((cmd, payload) => handleCommand(cmd, (payload ?? {}) as CommandArgs), {
  shouldMockEvents: true,
});
window.__yarvisDemoControls = {
  emit,
  fireAlarm,
  clipboardText: () => clipboardHistory[0]?.text ?? "",
};
