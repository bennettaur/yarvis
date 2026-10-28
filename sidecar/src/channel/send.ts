import { readSection } from "../settings/store.ts";
import { type ChannelHub, type ChannelMessage, channelHub } from "./hub.ts";
import { CHANNEL_SERVER_NAME } from "./relay.ts";

/**
 * True when the agent command starts sessions that listen to the relay.
 * Claude Code runs the relay either way, since it is in `.mcp.json`, but only
 * delivers its events with this flag. A connected relay alone would let a
 * message vanish into a session that drops it.
 */
export function agentCommandLoadsChannel(command: string | null | undefined): boolean {
  const parts = (command ?? "").split(/\s+/);
  return (
    parts.includes("--dangerously-load-development-channels") &&
    parts.includes(`server:${CHANNEL_SERVER_NAME}`)
  );
}

/** Reads the agent command the core launches sessions with (`agentCommand` in settings). */
async function configuredAgentLoadsChannel(): Promise<boolean> {
  const command = await readSection<string>("agentCommand").catch(() => null);
  return agentCommandLoadsChannel(command);
}

export interface ChannelSendOptions {
  hub?: ChannelHub;
  enabled?: () => Promise<boolean>;
}

/**
 * Hands `text` to the session's relay. Null when channels aren't switched on or
 * no relay is polling for that terminal, so the caller types into the PTY instead.
 */
export async function sendOverChannel(
  sessionKey: string,
  text: string,
  { hub = channelHub, enabled = configuredAgentLoadsChannel }: ChannelSendOptions = {},
): Promise<ChannelMessage | null> {
  if (!hub.isConnected(sessionKey) || !(await enabled())) return null;
  return hub.send(sessionKey, text);
}
