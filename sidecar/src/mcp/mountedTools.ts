/**
 * Per-session "mounted" tool set: the working set of search-discovered tools the
 * agent has deliberately made callable. Held in memory in the long-running
 * sidecar so the set stays hot across chat turns; cleared on sidecar restart.
 *
 * Entries expire after {@link MOUNT_TTL_MS} so a forgotten tool doesn't linger
 * in the agent's context forever — the 30-minute backstop from the design.
 * Stores registry ids (`builtin:<name>` / `mcp:<serverId>:<toolName>`).
 */

export const MOUNT_TTL_MS = 30 * 60 * 1000;

const mounted = new Map<string, Map<string, number>>();

function bucket(sessionId: string): Map<string, number> {
  let b = mounted.get(sessionId);
  if (!b) {
    b = new Map();
    mounted.set(sessionId, b);
  }
  return b;
}

export function mountTools(sessionId: string, ids: string[], now: number = Date.now()): void {
  const b = bucket(sessionId);
  for (const id of ids) b.set(id, now);
}

export function unmountTools(sessionId: string, ids: string[]): void {
  const b = mounted.get(sessionId);
  if (!b) return;
  for (const id of ids) b.delete(id);
  if (b.size === 0) mounted.delete(sessionId);
}

export function unmountAll(sessionId: string): void {
  mounted.delete(sessionId);
}

/** The session's non-expired mounted tool ids, pruning expired entries. */
export function activeMounted(sessionId: string, now: number = Date.now()): string[] {
  const b = mounted.get(sessionId);
  if (!b) return [];
  const out: string[] = [];
  for (const [id, at] of b) {
    if (now - at > MOUNT_TTL_MS) b.delete(id);
    else out.push(id);
  }
  if (b.size === 0) mounted.delete(sessionId);
  return out;
}
