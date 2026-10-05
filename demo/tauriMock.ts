/**
 * Stands in for the Rust core so the real frontend runs in a plain browser.
 *
 * Every `invoke` the UI makes is answered here, and `listen` is backed by
 * Tauri's own event mock so a demo can fire native events (an alarm going
 * off, the Quick Chat hotkey) with `window.__yarvisDemo.emit`. Data still
 * comes from a real sidecar; only the native layer is faked.
 *
 * The sidecar's port and token arrive on `window.__YARVIS_DEMO__`, which the
 * Playwright fixture sets before any page script runs.
 */

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Alarm } from "../src/lib/alarms";
import type { ClipboardHistoryItem } from "../src/lib/clipboard";
import type { Settings } from "../src/lib/settings";

export interface DemoConfig {
  sidecarPort: number;
  sidecarToken: string;
  /** Secret keys the Settings screen should show as stored. */
  presentSecrets?: string[];
  alarms?: Alarm[];
  clipboardHistory?: ClipboardHistoryItem[];
}

declare global {
  interface Window {
    __YARVIS_DEMO__?: DemoConfig;
    __yarvisDemo?: {
      emit: typeof emit;
      fireAlarm: (alarm: Omit<Alarm, "status">) => Promise<void>;
      calls: { cmd: string; args: unknown }[];
    };
  }
}

const config = window.__YARVIS_DEMO__;
if (!config) {
  throw new Error("demo/index.html needs window.__YARVIS_DEMO__; open it through the demo runner");
}

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

// Defaults copied from `src-tauri/src/settings.rs` and `pty.rs`.
let settings: Settings = {
  maxPtySessions: null,
  defaultMaxPtySessions: 8,
  maxConfigurablePtySessions: 32,
  agentName: null,
  agentCommand: null,
  defaultAgentName: "Claude Code",
  defaultAgentCommand: "claude",
  agentCommandOverriddenByEnv: false,
  azureDevopsOrgUrl: null,
  jiraBaseUrl: null,
  jiraEmail: null,
  googleClientId: null,
  telegramOtpWindowMinutes: null,
  defaultTelegramOtpWindowMinutes: 10,
  secretBackend: "keychain",
  onePasswordVault: null,
  onePasswordItem: null,
};

const presentSecrets = new Set(config.presentSecrets ?? ["database_url"]);
let alarms: Alarm[] = config.alarms ?? [];
let clipboardHistory: ClipboardHistoryItem[] = config.clipboardHistory ?? [];

type Args = Record<string, unknown>;

function update(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch };
  return settings;
}

function setAlarm(id: string, patch: Partial<Alarm>): void {
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

function handle(cmd: string, args: Args): unknown {
  switch (cmd) {
    case "get_sidecar_info":
      return { port: config?.sidecarPort, token: config?.sidecarToken };
    case "get_sidecar_log_path":
      return "~/Library/Logs/Yarvis/sidecar.log";
    case "restart_sidecar":
    case "focus_main_window":
      return null;

    case "get_settings":
      return settings;
    case "set_max_pty_sessions":
      return update({ maxPtySessions: args.value as number | null });
    case "set_agent":
      return update({
        agentName: args.name as string | null,
        agentCommand: args.command as string | null,
      });
    case "set_azure_devops_org_url":
      return update({ azureDevopsOrgUrl: args.value as string | null });
    case "set_jira_base_url":
      return update({ jiraBaseUrl: args.value as string | null });
    case "set_jira_email":
      return update({ jiraEmail: args.value as string | null });
    case "set_google_client_id":
      return update({ googleClientId: args.value as string | null });
    case "set_telegram_otp_window_minutes":
      return update({ telegramOtpWindowMinutes: args.value as number | null });
    case "set_secret_backend":
      return {
        settings: update({
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
      setAlarm(args.id as string, { status: "cancelled" });
      return null;
    case "acknowledge_alarm":
      setAlarm(args.id as string, { status: "acknowledged" });
      return null;
    case "snooze_alarm":
      setAlarm(args.id as string, {
        status: "scheduled",
        fireAtMs: Date.now() + (args.minutes as number) * 60_000,
      });
      return null;

    case "clipboard_history":
      return clipboardHistory;
    case "clipboard_clear_history":
      clipboardHistory = [];
      return null;
    case "clipboard_write":
      return null;

    // Terminals and agent sessions live in the Rust core's PTYs, which the
    // browser can't reach. They open empty; a demo can write output into one
    // by emitting `pty-output:<id>`.
    case "get_agent_config":
      return { name: "Claude Code", command: "claude" };
    case "pty_exists":
    case "pty_is_busy":
      return false;
    case "pty_attach":
      return { scrollback: [], endOffset: 0 };
    case "pty_write":
    case "pty_resize":
    case "pty_kill":
    case "pty_start_claude":
      return null;

    case "plugin:opener|open_url":
      return null;

    default:
      console.warn(`[demo] unmocked Tauri command: ${cmd}`, args);
      return null;
  }
}

const calls: { cmd: string; args: unknown }[] = [];
mockIPC(
  (cmd, payload) => {
    calls.push({ cmd, args: payload });
    return handle(cmd, (payload ?? {}) as Args);
  },
  { shouldMockEvents: true },
);
window.__yarvisDemo = { emit, fireAlarm, calls };
