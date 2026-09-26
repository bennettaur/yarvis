/**
 * The link between the agent and the Chrome extension.
 *
 * An extension cannot listen on a socket, so the direction is reversed: the
 * extension (through its native-messaging host, see `scripts/browser/`) holds a
 * long poll open against `/browser/next`, and a tool that wants something from
 * the browser queues a command here and waits for the answer to come back on
 * `/browser/result`. Nothing is stored — a command that nobody collects times
 * out, and a page's text lives only as long as the tool call that asked for it.
 */

export type BrowserCommand =
  | { type: "list_tabs" }
  | { type: "read_page"; tabId?: number; maxChars: number };

export interface QueuedCommand {
  id: string;
  command: BrowserCommand;
}

export interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** How long a poll is held open before it answers "nothing yet". */
export const POLL_HOLD_MS = 25_000;

/**
 * How recently the extension must have polled to count as connected. A poll is
 * re-issued as soon as one answers, so a gap this long means the browser or the
 * host is gone — and failing fast beats making the agent wait out a timeout.
 */
const CONNECTED_WITHIN_MS = POLL_HOLD_MS + 10_000;

/** How long a tool waits for the page to answer before giving up. */
export const REQUEST_TIMEOUT_MS = 20_000;

export class BrowserNotConnectedError extends Error {
  constructor() {
    super(
      "No browser is connected to Yarvis. The Yarvis Chrome extension must be installed and Chrome running — see extension/README.md.",
    );
  }
}

interface Inflight {
  resolve: (result: CommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserBridge {
  /**
   * Presented by the native host. Scoped like the attention and MCP tokens: it
   * reaches these routes and nothing else, and it is minted per launch and
   * handed over through a 0600 discovery file rather than through the webview.
   */
  readonly token: string;

  private lastPollAt = 0;
  private readonly queue: QueuedCommand[] = [];
  private readonly inflight = new Map<string, Inflight>();
  private waiter: ((next: QueuedCommand | null) => void) | null = null;

  constructor(token = randomToken()) {
    this.token = token;
  }

  get connected(): boolean {
    return Date.now() - this.lastPollAt < CONNECTED_WITHIN_MS;
  }

  /** Queues a command and resolves with what the extension answered. */
  request(command: BrowserCommand, timeoutMs = REQUEST_TIMEOUT_MS): Promise<CommandResult> {
    if (!this.connected) return Promise.reject(new BrowserNotConnectedError());
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        const queued = this.queue.findIndex((q) => q.id === id);
        if (queued >= 0) this.queue.splice(queued, 1);
        resolve({ ok: false, error: "The browser did not answer in time." });
      }, timeoutMs);
      this.inflight.set(id, { resolve, timer });
      const item = { id, command };
      if (this.waiter) {
        const wake = this.waiter;
        this.waiter = null;
        wake(item);
      } else {
        this.queue.push(item);
      }
    });
  }

  /**
   * The extension's poll: the next command, or null after `holdMs`. A newer poll
   * supersedes an older one (a restarted host would otherwise leave a dead
   * waiter swallowing the next command).
   */
  next(holdMs = POLL_HOLD_MS, signal?: AbortSignal): Promise<QueuedCommand | null> {
    this.lastPollAt = Date.now();
    this.waiter?.(null);
    this.waiter = null;
    const ready = this.queue.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const finish = (value: QueuedCommand | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiter === finish) this.waiter = null;
        this.lastPollAt = Date.now();
        resolve(value);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), holdMs);
      signal?.addEventListener("abort", onAbort);
      this.waiter = finish;
    });
  }

  /** Delivers an answer. False when nothing is waiting on it (late or unknown id). */
  complete(id: string, result: CommandResult): boolean {
    const pending = this.inflight.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.inflight.delete(id);
    pending.resolve(result);
    return true;
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The bridge this sidecar process serves and its tools call. */
export const browserBridge = new BrowserBridge();
