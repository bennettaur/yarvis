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
