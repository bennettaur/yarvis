import { readSection } from "../settings/store.ts";
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

/**
 * True when a process's command line (`ps -o args=`) begins with the agent
 * command, word for word, and that command loads the channel.
 * - Only the command's own words count. `ps` joins argv with spaces, so a flag
 *   inside a later argument, such as the workspace name the core passes to
 *   `--remote-control` (which can come from an issue title), would otherwise
 *   read as real.
 * - The program matches by file name as argv[0], or as argv[1] when another
 *   program runs it, as an interpreter runs a script. Which program that is
 *   isn't checked: the pid must also be one the SessionStart hook registered.
 * - An agent command with quoting or env assignments never matches, so its
 *   sessions are typed into instead.
 */
export function launchedFromChannelCommand(processArgs: string, agentCommand: string): boolean {
  if (!agentCommandLoadsChannel(agentCommand)) return false;
  const fileName = (word: string) => word.slice(word.lastIndexOf("/") + 1);
  const [program = "", ...commandArgs] = agentCommand.trim().split(/\s+/);
  const args = processArgs.trim().split(/\s+/);
  const start = args.slice(0, 2).findIndex((arg) => fileName(arg) === fileName(program));
  if (start < 0) return false;
  return commandArgs.every((arg, i) => args[start + 1 + i] === arg);
}

/**
 * The experimental Settings switch for messaging sessions over the channel.
 * The core owns it (`channel_messaging` in `settings.rs`) and nothing in the
 * sidecar writes it, so the assistant can't turn it on for itself.
 */
const CHANNEL_MESSAGING_SETTING = "channelMessaging";

/** Whether channel messaging is switched on in Settings. Off when unset or unreadable. */
export async function channelMessagingEnabled(): Promise<boolean> {
  try {
    return (await readSection<boolean>(CHANNEL_MESSAGING_SETTING)) === true;
  } catch {
    return false;
  }
}

export interface ChannelSendOptions {
  hub?: ChannelHub;
  /** Overrides the Settings switch, for tests. */
  enabled?: () => Promise<boolean>;
}

/**
 * Hands `text` to the session's relay. Null when nothing that would deliver it
 * is listening, so the caller types into the PTY instead. Three things must
 * hold:
 * - a relay is live for that terminal,
 * - the Claude Code that started it was launched with the channel flag, which
 *   the relay checked when it started, since a message to a session without it
 *   is dropped,
 * - that Claude Code is one the workspace's SessionStart hook registered.
 *
 * The relay reports its own pid and flag, and the sidecar can't check either.
 * Any process in the terminal holds the session token, so while no relay owns
 * the channel, one could claim a registered pid and take its messages. That
 * process already runs as the user and could type at the prompt instead, and
 * what it replies is read as untrusted text.
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
