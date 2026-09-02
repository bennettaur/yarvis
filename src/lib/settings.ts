import { invoke } from "@tauri-apps/api/core";

/**
 * Client for the settings the Rust core owns (`src-tauri/src/settings.rs`),
 * persisted as `settings.json` in the app data directory. Preferences the
 * sidecar owns (repos, embeddings) go through `lib/api` instead; these are the
 * ones the core itself reads.
 */

export interface Settings {
  /** Cap on live terminal sessions; null means the built-in default applies. */
  maxPtySessions: number | null;
  /** The cap that applies while `maxPtySessions` is null. */
  defaultMaxPtySessions: number;
  /** The highest cap the core will honour; anything above is clamped to it. */
  maxConfigurablePtySessions: number;
  /** Title for a workspace's agent tab; null means the default applies. */
  agentName: string | null;
  /** Command a workspace's agent session is launched from; null means the
   *  default applies. */
  agentCommand: string | null;
  /** The name that applies while `agentName` is null. */
  defaultAgentName: string;
  /** The command that applies while `agentCommand` is null. */
  defaultAgentCommand: string;
  /** True while `YARVIS_CLAUDE_COMMAND` is set, which outranks `agentCommand`. */
  agentCommandOverriddenByEnv: boolean;
  /** Azure DevOps organization base URL for the PR dashboard. */
  azureDevopsOrgUrl: string | null;
  /** Atlassian Cloud site base URL for the Issues dashboard. */
  jiraBaseUrl: string | null;
  /** Atlassian account email paired with the JIRA API token (Keychain). */
  jiraEmail: string | null;
  /** Google Cloud OAuth client id for the calendar integration. */
  googleClientId: string | null;
  /** Comma-separated Telegram chat ids allowed to use the remote-control bot. */
  telegramAllowedChatIds: string | null;
  /** Re-auth window, in minutes, for the Telegram bot's OTP gate; null means
   *  the default applies. */
  telegramOtpWindowMinutes: number | null;
  /** The window that applies while `telegramOtpWindowMinutes` is null. */
  defaultTelegramOtpWindowMinutes: number;
}

export const getSettings = () => invoke<Settings>("get_settings");

/** Sets the live-terminal cap, or clears it back to the default with `null`.
 * Takes effect on the next terminal opened — no restart. Rejects zero. */
export const setMaxPtySessions = (value: number | null) =>
  invoke<Settings>("set_max_pty_sessions", { value });

/** Sets the agent's tab title and launch command, clearing either back to its
 * default with `null` or a blank string. Takes effect on the next agent session
 * started — no restart. Rejects a value spanning more than one line. */
export const setAgent = (name: string | null, command: string | null) =>
  invoke<Settings>("set_agent", { name, command });

/**
 * The settings below are injected into the sidecar's environment at spawn
 * time, so a saved change only takes effect once the sidecar restarts — call
 * `restartSidecar` from `lib/keychain` after saving, the same as a Keychain
 * secret change.
 */

export const setAzureDevopsOrgUrl = (value: string | null) =>
  invoke<Settings>("set_azure_devops_org_url", { value });

export const setJiraBaseUrl = (value: string | null) =>
  invoke<Settings>("set_jira_base_url", { value });

export const setJiraEmail = (value: string | null) => invoke<Settings>("set_jira_email", { value });

export const setGoogleClientId = (value: string | null) =>
  invoke<Settings>("set_google_client_id", { value });

export const setTelegramAllowedChatIds = (value: string | null) =>
  invoke<Settings>("set_telegram_allowed_chat_ids", { value });

/** Rejects zero; `null` clears back to `defaultTelegramOtpWindowMinutes`. */
export const setTelegramOtpWindowMinutes = (value: number | null) =>
  invoke<Settings>("set_telegram_otp_window_minutes", { value });
