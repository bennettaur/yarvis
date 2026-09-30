/**
 * The link between the agent and the Chrome extension.
 *
 * An extension cannot listen on a socket, so the direction is reversed: the
 * extension (through its native-messaging host, see `scripts/browser/`) holds a
 * long poll open against `/browser/next`, and a tool that wants something from
 * the browser queues a command here and waits for the answer to come back on
 * `/browser/result`. Nothing is stored — a command that nobody collects times
 * out, and a page's text lives only as long as the tool call that asked for it.
 *
 * Each Chrome profile running the extension polls under its own id and a name
 * the user gives it ("work", "personal"), so a tool can say which browser it
 * means. Every profile gets its own queue.
 */

export type BrowserCommand =
  | { type: "list_tabs" }
  | { type: "read_page"; tabId?: number; maxChars: number }
  | { type: "list_elements"; tabId?: number; maxElements: number }
  | { type: "click"; tabId?: number; ref: number }
  | { type: "scroll"; tabId?: number; ref?: number; direction: "up" | "down" | "top" | "bottom" }
  | { type: "navigate"; tabId?: number; url: string };

export interface QueuedCommand {
  id: string;
  command: BrowserCommand;
}

/** A Chrome profile as it identifies itself when it polls. */
export interface BrowserProfile {
  /** Random and stable per profile; the name can change, this can't. */
  id: string;
  name: string;
}

/**
 * What a poll resolves to. "superseded" is distinct from an idle expiry (null) so
 * two hosts polling as the same profile don't tight-loop displacing each other:
 * the displaced one is told, and backs off.
 */
export type PollResult = QueuedCommand | null | "superseded";

export interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface RequestOptions {
  /** Profile name or id. Needed only when more than one profile is connected. */
  profile?: string;
  timeoutMs?: number;
}

/** How long a poll is held open before it answers "nothing yet". */
export const POLL_HOLD_MS = 25_000;

/**
 * How recently a profile must have polled to count as connected. A poll is
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

interface Channel {
  profile: BrowserProfile;
  lastPollAt: number;
  queue: QueuedCommand[];
  waiter: ((next: PollResult) => void) | null;
}

interface Inflight {
  channel: Channel;
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

  private readonly channels = new Map<string, Channel>();
  private readonly inflight = new Map<string, Inflight>();

  constructor(token = randomToken()) {
    this.token = token;
  }

  /** The profiles that have polled recently enough to answer a command. */
  profiles(): BrowserProfile[] {
    return [...this.channels.values()].filter(isLive).map((channel) => ({ ...channel.profile }));
  }

  get connected(): boolean {
    return this.profiles().length > 0;
  }

  /** Queues a command for one profile and resolves with what it answered. */
  request(command: BrowserCommand, options: RequestOptions = {}): Promise<CommandResult> {
    let channel: Channel;
    try {
      channel = this.pick(options.profile);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        const queued = channel.queue.findIndex((q) => q.id === id);
        if (queued >= 0) channel.queue.splice(queued, 1);
        resolve({ ok: false, error: "The browser did not answer in time." });
      }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
      this.inflight.set(id, { channel, resolve, timer });
      const item = { id, command };
      if (channel.waiter) {
        const wake = channel.waiter;
        channel.waiter = null;
        wake(item);
      } else {
        channel.queue.push(item);
      }
    });
  }

  /**
   * A profile's poll: the next command for it, or null after `holdMs`. A newer
   * poll from the same profile supersedes an older one (a restarted host would
   * otherwise leave a dead waiter swallowing the next command).
   */
  next(profile: BrowserProfile, holdMs = POLL_HOLD_MS, signal?: AbortSignal): Promise<PollResult> {
    const channel = this.channelFor(profile);
    channel.lastPollAt = Date.now();
    channel.waiter?.("superseded");
    channel.waiter = null;
    const ready = channel.queue.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const finish = (value: PollResult) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (channel.waiter === finish) channel.waiter = null;
        channel.lastPollAt = Date.now();
        resolve(value);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), holdMs);
      signal?.addEventListener("abort", onAbort);
      channel.waiter = finish;
    });
  }

  /**
   * Puts a command back at the front when the poll it was handed to has gone away
   * before the response could be written — otherwise it is out of the queue and
   * in nobody's hands, and the tool waits out its whole timeout.
   */
  requeue(item: QueuedCommand): void {
    this.inflight.get(item.id)?.channel.queue.unshift(item);
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

  private channelFor(profile: BrowserProfile): Channel {
    const existing = this.channels.get(profile.id);
    if (existing) {
      // The user can rename a profile at any time; the id is what stays put.
      existing.profile.name = profile.name;
      return existing;
    }
    const channel: Channel = { profile: { ...profile }, lastPollAt: 0, queue: [], waiter: null };
    this.channels.set(profile.id, channel);
    return channel;
  }

  private pick(wanted: string | undefined): Channel {
    const live = [...this.channels.values()].filter(isLive);
    if (live.length === 0) throw new BrowserNotConnectedError();
    const names = live.map((channel) => channel.profile.name).join(", ");
    if (wanted === undefined) {
      if (live.length === 1) return live[0] as Channel;
      throw new Error(
        `Several Chrome profiles are connected (${names}). Say which one with the profile argument.`,
      );
    }
    const key = wanted.trim().toLowerCase();
    const matches = live.filter(
      (channel) => channel.profile.id === wanted || channel.profile.name.toLowerCase() === key,
    );
    if (matches.length === 1) return matches[0] as Channel;
    if (matches.length > 1) {
      throw new Error(
        `More than one connected Chrome profile is called "${wanted}". Rename one in the Yarvis extension's popup.`,
      );
    }
    throw new Error(`No connected Chrome profile is called "${wanted}". Connected: ${names}.`);
  }
}

function isLive(channel: Channel): boolean {
  return Date.now() - channel.lastPollAt < CONNECTED_WITHIN_MS;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The bridge this sidecar process serves and its tools call. */
export const browserBridge = new BrowserBridge();
