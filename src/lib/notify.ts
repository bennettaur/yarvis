import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * Shows an OS notification, requesting permission on first use. Best-effort: any
 * failure (e.g. running outside the desktop shell, or permission denied) is
 * swallowed so callers don't have to guard.
 */
export async function notify(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // ignore — notifications are a nicety, not a requirement
  }
}
