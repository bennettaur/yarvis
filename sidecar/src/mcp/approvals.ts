/**
 * In-process human-in-the-loop approval registry for MCP tool calls.
 *
 * Every MCP tool invocation pauses inside its `execute` wrapper, awaiting a
 * decision delivered out-of-band by the chat approval endpoint. Keyed by the AI
 * SDK's globally-unique `toolCallId`, so it needs no per-session scoping.
 *
 * A decision that arrives before the waiter has registered (a race between the
 * SSE approval event and the tool's execute) is remembered in `predecided` so it
 * is not lost.
 */

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

interface Waiter {
  resolve: (approved: boolean) => void;
}

const pending = new Map<string, Waiter>();
const predecided = new Map<string, boolean>();

export interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Blocks until the user approves or denies the given tool call. Resolves false
 * (deny) on timeout or if the request is aborted (client disconnect), so a tool
 * never hangs the generation indefinitely.
 */
export function waitForApproval(toolCallId: string, options: WaitOptions = {}): Promise<boolean> {
  const decided = predecided.get(toolCallId);
  if (decided !== undefined) {
    predecided.delete(toolCallId);
    return Promise.resolve(decided);
  }
  const timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(toolCallId);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      pending.delete(toolCallId);
      resolve(false);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(toolCallId, {
      resolve: (approved) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(approved);
      },
    });
  });
}

/**
 * Records the user's decision for a tool call. Returns true if a waiter was
 * waiting; otherwise the decision is stored for an imminent {@link waitForApproval}.
 */
export function resolveApproval(toolCallId: string, approved: boolean): boolean {
  const waiter = pending.get(toolCallId);
  if (waiter) {
    pending.delete(toolCallId);
    waiter.resolve(approved);
    return true;
  }
  predecided.set(toolCallId, approved);
  return false;
}
