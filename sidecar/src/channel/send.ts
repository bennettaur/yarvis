import { type ChannelHub, type ChannelMessage, channelHub } from "./hub.ts";

export const CHANNEL_SERVER_NAME = "yarvis-channel";

const DEV_CHANNELS_FLAG = "--dangerously-load-development-channels";

/**
 * True when an agent command launches sessions that listen to the relay.
 * Claude Code runs the relay either way, since it is in `.mcp.json`, but only
 * delivers its events with this flag.
 */
export function agentCommandLoadsChannel(command: string | null | undefined): boolean {
  const parts = (command ?? "").split(/\s+/).flatMap((part) => part.split("="));
  return parts.includes(DEV_CHANNELS_FLAG) && parts.includes(`server:${CHANNEL_SERVER_NAME}`);
}

export interface ChannelSendOptions {
  hub?: ChannelHub;
}

/**
 * Hands `text` to the session's relay. Null when nothing that would deliver it
 * is listening, so the caller types into the PTY instead. Three things must
 * hold:
 * - a relay is live for that terminal,
 * - the Claude Code that started it was launched with the channel flag, which
 *   the relay checked when it started, since a message to a session without it
 *   is dropped,
 * - that Claude Code is one the workspace's SessionStart hook registered, so a
 *   stray process in the terminal holding the session token can't stand in.
 */
export function sendOverChannel(
  sessionKey: string,
  text: string,
  agentPids: number[],
  { hub = channelHub }: ChannelSendOptions = {},
): ChannelMessage | null {
  const listener = hub.listener(sessionKey);
  if (!listener?.channelEnabled || !agentPids.includes(listener.pid)) return null;
  return hub.send(sessionKey, text);
}
