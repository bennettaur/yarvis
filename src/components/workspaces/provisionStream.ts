import { type ProvisionEvent, provisionWorkspace } from "../../lib/workspaces";

/** Human-readable line for a provisioning progress event, or null to ignore. */
export function provisionEventLine(ev: ProvisionEvent): string | null {
  if (ev.type === "log") return ev.text;
  if (ev.type === "repo-start") return `\n=== ${ev.repo} ===\n`;
  if (ev.type === "repo-error") return `\n[error] ${ev.message}\n`;
  return null;
}

/**
 * Drives a provision stream, appending progress text via `onLine`. Resolves
 * once the stream ends. Only a hard top-level `error` event (workspace not
 * found, provisioning failed outright) is returned, so the caller can show it
 * inline. A workspace already being provisioned is not one of those: the stream
 * follows the run in flight, which is how reopening a workspace mid-provision
 * picks its log back up.
 * A repo whose setup script failed is not a top-level error — the stream still
 * ends with a `done` event — so it resolves without one; the caller then
 * reloads and lands on the detail view, where the failed repo's setup log is
 * surfaced.
 */
export async function consumeProvision(
  id: string,
  onLine: (text: string) => void,
): Promise<{ error?: string }> {
  for await (const ev of provisionWorkspace(id)) {
    const line = provisionEventLine(ev);
    if (line !== null) onLine(line);
    else if (ev.type === "error") return { error: ev.message };
    else if (ev.type === "done") return {};
  }
  return {};
}
