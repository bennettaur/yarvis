/**
 * Messages between the Yarvis agent and the Claude Code sessions it launched,
 * carried over Claude Code's channel feature instead of typed into the PTY.
 *
 * Each session runs a small relay (`relay.ts`) as a stdio MCP server. The relay
 * long-polls `/ingest/channel/next` for messages addressed to its terminal and
 * hands each one to Claude Code as a channel event, which arrives in the
 * session as its own turn. The session answers through the relay's `reply`
 * tool, which posts to `/ingest/channel/reply` and lands here for the agent to
 * read back.
 *
 * Held in memory on purpose. A message is only useful to a session that is
 * running now, and a reply is read back within the conversation that asked for
 * it, so neither needs to outlive the sidecar.
 */

/** How long one long-poll is held open before it returns empty. */
export const POLL_HOLD_MS = 25_000;

/**
 * A relay counts as connected while its last poll is this recent. Wider than
 * `POLL_HOLD_MS` so the gap between one poll ending and the next starting
 * doesn't read as a disconnect.
 */
const CONNECTED_WINDOW_MS = POLL_HOLD_MS + 15_000;

/** Bounds what one session can pile up if its relay stops polling. */
const MAX_QUEUED = 20;

/** Replies kept per session; the oldest drop first. */
const MAX_REPLIES = 50;

export interface ChannelMessage {
  id: string;
  text: string;
  sentAt: string;
}

export interface ChannelReply {
  /** The message this answers, when the session named one. */
  messageId: string | null;
  text: string;
  at: string;
}

interface SessionChannel {
  queue: ChannelMessage[];
  /** The relay's poll that is waiting right now, if one is. */
  waiter: ((messages: ChannelMessage[]) => void) | null;
  lastPollAt: number;
  replies: ChannelReply[];
}

export class ChannelHub {
  private sessions = new Map<string, SessionChannel>();

  constructor(private now: () => number = Date.now) {}

  private session(sessionKey: string): SessionChannel {
    let s = this.sessions.get(sessionKey);
    if (!s) {
      s = { queue: [], waiter: null, lastPollAt: 0, replies: [] };
      this.sessions.set(sessionKey, s);
    }
    return s;
  }

  /** True when a relay for this terminal is polling, so a message would reach it. */
  isConnected(sessionKey: string): boolean {
    const s = this.sessions.get(sessionKey);
    if (!s) return false;
    return s.waiter !== null || this.now() - s.lastPollAt < CONNECTED_WINDOW_MS;
  }

  /**
   * Queues `text` for the session's relay. Returns null when no relay is
   * connected, so the caller can fall back to typing into the PTY instead of
   * leaving the message where nothing will read it.
   */
  send(sessionKey: string, text: string): ChannelMessage | null {
    if (!this.isConnected(sessionKey)) return null;
    const s = this.session(sessionKey);
    const message = { id: crypto.randomUUID(), text, sentAt: new Date(this.now()).toISOString() };
    if (s.waiter) {
      const waiter = s.waiter;
      s.waiter = null;
      waiter([message]);
    } else {
      if (s.queue.length >= MAX_QUEUED) return null;
      s.queue.push(message);
    }
    return message;
  }

  /**
   * The relay's long-poll: returns what is queued, or waits up to
   * `POLL_HOLD_MS` for something to arrive. A second poll for the same terminal
   * ends the first one empty, so a restarted relay takes over at once.
   */
  next(sessionKey: string, signal?: AbortSignal): Promise<ChannelMessage[]> {
    const s = this.session(sessionKey);
    s.lastPollAt = this.now();
    if (s.queue.length > 0) {
      const messages = s.queue;
      s.queue = [];
      return Promise.resolve(messages);
    }
    if (s.waiter) s.waiter([]);
    return new Promise((resolve) => {
      const finish = (messages: ChannelMessage[]) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (s.waiter === finish) s.waiter = null;
        s.lastPollAt = this.now();
        resolve(messages);
      };
      const onAbort = () => finish([]);
      const timer = setTimeout(() => finish([]), POLL_HOLD_MS);
      signal?.addEventListener("abort", onAbort);
      s.waiter = finish;
    });
  }

  /** Records what the session answered through its relay's `reply` tool. */
  reply(sessionKey: string, reply: Omit<ChannelReply, "at">): void {
    const s = this.session(sessionKey);
    s.replies.push({ ...reply, at: new Date(this.now()).toISOString() });
    if (s.replies.length > MAX_REPLIES) s.replies.splice(0, s.replies.length - MAX_REPLIES);
  }

  /** Replies from the session, oldest first, optionally only those to one message. */
  replies(sessionKey: string, messageId?: string): ChannelReply[] {
    const all = this.sessions.get(sessionKey)?.replies ?? [];
    return messageId ? all.filter((r) => r.messageId === messageId) : [...all];
  }
}

/** The hub the routes and the agent tools share. */
export const channelHub = new ChannelHub();
