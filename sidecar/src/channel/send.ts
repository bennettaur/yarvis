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
 * True when a process's command line (`ps -o args=`) is the agent command
 * starting, and that command loads the channel. Only the command's own words
 * are compared, from the start: whatever the launch adds after them, such as an
 * issue's text as the opening prompt, can't supply the flag. `ps` joins argv
 * with spaces, so a flag inside a quoted prompt would otherwise read as real.
 * The program matches by file name as argv[0], or as argv[1] when an
 * interpreter runs it as a script. An agent command with quoting or env
 * assignments never matches, so its sessions are typed into instead.
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
