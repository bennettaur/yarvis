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

/** Null for anything that isn't a usable entry, so one bad file can't stop the rest. */
export function parseInstance(value: unknown): Instance | null {
  const entry = value as Partial<Instance> | null;
  if (
    typeof entry?.name !== "string" ||
    typeof entry.token !== "string" ||
    !Number.isInteger(entry.port) ||
    (entry.port as number) <= 0 ||
    (entry.port as number) >= 65536 ||
    !Number.isInteger(entry.pid) ||
    (entry.pid as number) <= 0
  ) {
    return null;
  }
  return {
    name: entry.name,
    port: entry.port as number,
    token: entry.token,
    pid: entry.pid as number,
  };
}
