/**
 * What the Playwright fixture (Node) and the Tauri mock (browser) agree on.
 * Kept free of imports so both sides can load it.
 */

export interface DemoConfig {
  sidecarPort: number;
  sidecarToken: string;
  /** Secret keys the Settings screen should show as stored. */
  presentSecrets: string[];
  /** The Google OAuth client id Settings shows; the sidecar has the same one. */
  googleClientId: string;
}

/** Prefix of the console warning the mock logs for a command it doesn't answer. */
export const UNMOCKED_COMMAND_WARNING = "[demo] unmocked Tauri command:";
