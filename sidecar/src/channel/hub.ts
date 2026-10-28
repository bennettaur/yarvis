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
 * A relay counts as live this long after its last poll ended. A live relay
 * polls again at once, so a longer gap means it died, and a message queued for
 * it would be reported delivered to nobody.
 */
const LIVE_GRACE_MS = 5_000;

/** A queued message older than this is dropped rather than handed to whichever relay polls next. */
const QUEUED_TTL_MS = 15_000;

/** Bounds what one session can pile up between polls. */
const MAX_QUEUED = 20;

/** Replies kept per session; the oldest drop first. */
const MAX_REPLIES = 50;

/** Sent message ids remembered per session, so a reply can be matched to one. */
const MAX_SENT_IDS = 50;

export interface ChannelMessage {
  id: string;
  text: string;
  sentAt: string;
}

export interface ChannelReply {
  messageId: string;
  text: string;
  at: string;
}

/** Who is polling: one relay process, and what it says about itself. */
export interface RelayIdentity {
  /** Random per relay process; the first live one owns the terminal's channel. */
  relayId: string;
  /** The relay's parent, which is the Claude Code process that started it. */
  pid: number;
  /** Whether that Claude Code was launched with the channel flag. */
  channelEnabled: boolean;
}

interface SessionChannel {
  owner: RelayIdentity | null;
  queue: ChannelMessage[];
  /** The owner's poll that is waiting right now, if one is. */
  waiter: ((messages: ChannelMessage[]) => void) | null;
  lastPollAt: number;
  sentIds: string[];
  replies: ChannelReply[];
}

export class ChannelHub {
  private sessions = new Map<string, SessionChannel>();

  constructor(private now: () => number = Date.now) {}

  private channel(sessionKey: string): SessionChannel {
    let channel = this.sessions.get(sessionKey);
    if (!channel) {
      channel = { owner: null, queue: [], waiter: null, lastPollAt: 0, sentIds: [], replies: [] };
      this.sessions.set(sessionKey, channel);
    }
    return channel;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private isLive(channel: SessionChannel): boolean {
    return channel.waiter !== null || this.now() - channel.lastPollAt < LIVE_GRACE_MS;
  }

  /** The relay that owns this terminal's channel, while it is live. */
  listener(sessionKey: string): RelayIdentity | null {
    const channel = this.sessions.get(sessionKey);
    return channel?.owner && this.isLive(channel) ? channel.owner : null;
  }

  /**
   * Queues `text` for the session's relay. Returns null when no relay is live
   * or its queue is full, so the caller can fall back to typing into the PTY
   * instead of leaving the message where nothing will read it.
   */
  send(sessionKey: string, text: string): ChannelMessage | null {
    const channel = this.sessions.get(sessionKey);
    if (!channel || !this.listener(sessionKey)) return null;
    if (!channel.waiter && channel.queue.length >= MAX_QUEUED) return null;
    const message = { id: crypto.randomUUID(), text, sentAt: this.timestamp() };
    channel.sentIds.push(message.id);
    if (channel.sentIds.length > MAX_SENT_IDS) channel.sentIds.shift();
    if (channel.waiter) {
      const waiter = channel.waiter;
      channel.waiter = null;
      waiter([message]);
    } else {
      channel.queue.push(message);
    }
    return message;
  }

  /**
   * The relay's long-poll: returns what is queued, or waits up to
   * `POLL_HOLD_MS` for something to arrive. Null when another relay owns the
   * channel and is still live, so a second Claude Code started from the same
   * terminal (a nested `claude -p`, say) can't take the session's messages.
   */
  next(
    sessionKey: string,
    relay: RelayIdentity,
    signal?: AbortSignal,
  ): Promise<ChannelMessage[]> | null {
    const channel = this.channel(sessionKey);
    if (channel.owner?.relayId !== relay.relayId) {
      if (channel.owner && this.isLive(channel)) return null;
      // A new owner is a new Claude Code; what was queued was meant for the last one.
      channel.queue = [];
    }
    channel.owner = relay;
    channel.lastPollAt = this.now();
    channel.waiter?.([]);

    const fresh = channel.queue.filter((m) => this.now() - Date.parse(m.sentAt) < QUEUED_TTL_MS);
    channel.queue = [];
    if (fresh.length > 0) return Promise.resolve(fresh);

    return new Promise((resolve) => {
      const finish = (messages: ChannelMessage[]) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (channel.waiter === finish) channel.waiter = null;
        channel.lastPollAt = this.now();
        resolve(messages);
      };
      const onAbort = () => finish([]);
      const timer = setTimeout(() => finish([]), POLL_HOLD_MS);
      signal?.addEventListener("abort", onAbort);
      channel.waiter = finish;
    });
  }

  /**
   * Records what the session answered. Refused unless it comes from the relay
   * that owns the channel and names a message this hub sent to that terminal.
   */
  recordReply(sessionKey: string, relayId: string, messageId: string, text: string): boolean {
    const channel = this.sessions.get(sessionKey);
    if (!channel || channel.owner?.relayId !== relayId || !channel.sentIds.includes(messageId)) {
      return false;
    }
    channel.replies.push({ messageId, text, at: this.timestamp() });
    if (channel.replies.length > MAX_REPLIES) channel.replies.shift();
    return true;
  }

  /** Replies from the session, oldest first, optionally only those to one message. */
  replies(sessionKey: string, messageId?: string): ChannelReply[] {
    const all = this.sessions.get(sessionKey)?.replies ?? [];
    return messageId ? all.filter((r) => r.messageId === messageId) : [...all];
  }

  /** Drops everything held for a terminal, e.g. when its workspace is archived. */
  forget(sessionKey: string): void {
    this.sessions.get(sessionKey)?.waiter?.([]);
    this.sessions.delete(sessionKey);
  }
}

/** The hub the routes and the agent tools share. */
export const channelHub = new ChannelHub();
