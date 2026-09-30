import { unlinkSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The sidecar's port is picked fresh each launch, so the native host cannot be
 * configured with it. Each running instance writes its own file here — name,
 * port, the bridge's scoped token and its pid — readable by the user alone, and
 * the host connects to every live one. Nothing about the browser is singular to
 * the machine, so every instance writes one, not just the one that owns
 * background work.
 */

export interface InstanceDiscovery {
  name: string;
  port: number;
  token: string;
  pid: number;
}

/** The host reads the same folder; `scripts/browser/instances.ts` must agree on it. */
export function instancesDir(): string {
  return (
    process.env.YARVIS_BROWSER_INSTANCES_DIR ?? join(homedir(), ".yarvis", "browser", "instances")
  );
}

/**
 * Instance names are free text and two processes can share one (`sidecar:dev`
 * beside the app are both the primary), so the pid keeps each file its own.
 */
export function instanceFileName(name: string, pid: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "instance"}-${pid}.json`;
}

/**
 * The app stops its sidecar with SIGKILL, so an exit handler rarely gets to run.
 * Each instance clears out the files of processes that are gone when it starts.
 */
async function sweepDeadEntries(dir: string): Promise<void> {
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      const { pid } = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
      if (typeof pid === "number" && pid > 0 && !alive(pid)) await unlink(path);
    } catch {
      // Unreadable or mid-write; leave it for whoever owns it.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeDiscovery(entry: InstanceDiscovery): Promise<string> {
  const dir = instancesDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await sweepDeadEntries(dir);
  const path = join(dir, instanceFileName(entry.name, entry.pid));
  // Written aside and renamed in, so the host never reads half a file.
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(entry), { mode: 0o600 });
  // `mode` only applies when the file is created; an older file keeps its bits.
  await chmod(temp, 0o600);
  await rename(temp, path);
  return path;
}

/**
 * Removes this instance's file on a clean exit, so the popup stops listing it.
 * A killed sidecar leaves it behind; the host skips it once the pid is gone and
 * the next instance to start deletes it.
 */
export function removeDiscoveryOnExit(path: string): void {
  process.on("exit", () => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  });
}
