import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Opens a URL in the system browser, but only http(s) — guards against
 * dangerous schemes (e.g. `javascript:`, `file:`) reaching the opener from
 * server-supplied data like PR links or calendar event details.
 */
export function openExternal(url: string | null | undefined): void {
  if (!url) return;
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return;
  }
  if (scheme !== "http:" && scheme !== "https:") return;
  void openUrl(url).catch(() => window.open(url));
}
