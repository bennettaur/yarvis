import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The sidecar's port is picked fresh each launch, so the native host cannot be
 * configured with it. This file is how the host finds the running sidecar: the
 * port and the bridge's scoped token, readable by the user alone. With several
 * instances running, the last one to start owns the browser.
 */

export function discoveryPath(): string {
  return process.env.YARVIS_BROWSER_DISCOVERY_PATH ?? join(homedir(), ".yarvis", "browser.json");
}

export async function writeDiscovery(port: number, token: string): Promise<void> {
  const path = discoveryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ port, token }), { mode: 0o600 });
  // `mode` only applies when the file is created; an older file keeps its bits.
  await chmod(path, 0o600);
}
