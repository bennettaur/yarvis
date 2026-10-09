import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The discovery files each running Yarvis sidecar writes, one per process.
 * `sidecar/src/browser/discovery.ts` writes them; the folder and the fields here
 * must match it.
 */

export interface Instance {
  name: string;
  port: number;
  token: string;
  pid: number;
}

export function instancesDir(): string {
  return (
    process.env.YARVIS_BROWSER_INSTANCES_DIR ?? join(homedir(), ".yarvis", "browser", "instances")
  );
}

/** What the sidecar mints (`randomToken` in sidecar/src/browser/bridge.ts): 32 random bytes as hex. */
const TOKEN = /^[0-9a-f]{64}$/;

/**
 * Null for anything that isn't a usable entry, so one bad file can't stop the
 * rest. The host sends `token` in an Authorization header to `port` on
 * 127.0.0.1, so both are held to exactly what a sidecar writes: a token of any
 * other shape could carry extra header text, and a privileged port is never one
 * a sidecar was given.
 */
export function parseInstance(value: unknown): Instance | null {
  const entry = value as Partial<Instance> | null;
  if (
    typeof entry?.name !== "string" ||
    typeof entry.token !== "string" ||
    !TOKEN.test(entry.token) ||
    !Number.isInteger(entry.port) ||
    (entry.port as number) < 1024 ||
    (entry.port as number) >= 65536 ||
    !Number.isInteger(entry.pid) ||
    (entry.pid as number) <= 0
  ) {
    return null;
  }
  return {
    name: entry.name.slice(0, 64),
    port: entry.port as number,
    token: entry.token,
    pid: entry.pid as number,
  };
}

/**
 * Whether a discovery file (or the folder holding it) can be trusted to point
 * the host somewhere: it must belong to this user and be writable by no one
 * else. Otherwise another account on the machine could plant a file that sends
 * the extension's page reads to a port it is listening on. The sidecar creates
 * the folder 0700 and each file 0600.
 */
export function ownedByMe(stat: { uid: number; mode: number }, myUid: number): boolean {
  return stat.uid === myUid && (stat.mode & 0o022) === 0;
}

/** A sidecar's entry is well under this; anything bigger isn't one. */
const MAX_ENTRY_BYTES = 4096;

/**
 * Reads a discovery file only if `ownedByMe` passes for that same file. The
 * check and the read go through one open handle, so the file can't be swapped
 * between them, and a symlink in its place is refused rather than followed.
 * O_NONBLOCK keeps a FIFO named like an entry from holding the open forever,
 * which would stall every later rescan; it changes nothing for a regular file.
 * Null when it isn't a regular file this user can trust.
 */
export async function readTrustedEntry(path: string, myUid: number): Promise<Instance | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES || !ownedByMe(stat, myUid)) return null;
    return parseInstance(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}
