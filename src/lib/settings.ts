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
}

export const getSettings = () => invoke<Settings>("get_settings");

/** Sets the live-terminal cap, or clears it back to the default with `null`.
 * Takes effect on the next terminal opened — no restart. Rejects zero. */
export const setMaxPtySessions = (value: number | null) =>
  invoke<Settings>("set_max_pty_sessions", { value });
