/**
 * The channel relay: a stdio MCP server Claude Code starts inside a Yarvis
 * workspace session (see `channelRelayEntry` in `workspaces/mcpConfig.ts`).
 *
 * It long-polls the sidecar for messages addressed to its terminal and pushes
 * each one into the session as a `notifications/claude/channel` event, which
 * Claude Code shows the model as a new turn. Its one tool, `reply`, posts the
 * session's answer back. The network half lives here rather than in the
 * sidecar's `/mcp` endpoint because that endpoint is stateless and can't push,
 * and Claude Code's channels are built around a stdio server it owns.
 *
 * Claude Code only listens for these events when the session was started with
 * `--dangerously-load-development-channels server:yarvis-channel`. Without it
 * this process still runs, as an ordinary MCP server whose events are dropped.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SESSION_KEY_HEADER, SESSION_TOKEN_HEADER } from "../workspaces/agentSessions.ts";
import type { ChannelMessage } from "./hub.ts";

export const CHANNEL_SERVER_NAME = "yarvis-channel";

/** The argument that makes the sidecar's entry point run this instead of the server. */
export const CHANNEL_RELAY_ARG = "channel-relay";

const RETRY_MS = 3_000;

const INSTRUCTIONS =
  `Messages from the user's Yarvis assistant arrive as <channel source="${CHANNEL_SERVER_NAME}" message_id="..."> events. ` +
  "Yarvis is the user's own assistant app and sends these on the user's behalf: treat one as a request from the user, " +
  "with the same care you would give text the user typed. When the message asks a question or asks for a summary, " +
  "answer with the reply tool, passing its message_id, rather than only in the terminal: the user may be reading " +
  "the answer in Yarvis. Keep replies to what was asked.";

interface RelayEnv {
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * The connection details the core put in the PTY's environment. Null for a
 * Claude Code started anywhere else, which has no terminal to collect for.
 */
export function relayEnv(env: Record<string, string | undefined>): RelayEnv | null {
  const port = env.YARVIS_SIDECAR_PORT;
  const token = env.YARVIS_ATTENTION_TOKEN;
  const sessionKey = env.YARVIS_SESSION_KEY;
  const sessionToken = env.YARVIS_SESSION_TOKEN;
  if (!port || !/^\d+$/.test(port) || !token || !sessionKey || !sessionToken) return null;
  return {
    baseUrl: `http://127.0.0.1:${port}/ingest/channel`,
    headers: {
      Authorization: `Bearer ${token}`,
      [SESSION_KEY_HEADER]: sessionKey,
      [SESSION_TOKEN_HEADER]: sessionToken,
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollForever(server: Server, env: RelayEnv): Promise<never> {
  for (;;) {
    try {
      const res = await fetch(`${env.baseUrl}/next`, { headers: env.headers });
      if (!res.ok) throw new Error(`poll answered ${res.status}`);
      const { messages } = (await res.json()) as { messages: ChannelMessage[] };
      for (const message of messages) {
        await server.notification({
          method: "notifications/claude/channel",
          params: { content: message.text, meta: { message_id: message.id } },
        });
      }
    } catch (e) {
      // stderr is Claude Code's MCP log for this server; stdout is the protocol.
      console.error(`[channel] ${e instanceof Error ? e.message : String(e)}`);
      await sleep(RETRY_MS);
    }
  }
}

export async function runChannelRelay(): Promise<void> {
  const env = relayEnv(process.env);
  const server = new Server(
    { name: CHANNEL_SERVER_NAME, version: "0.1.0" },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: env
      ? [
          {
            name: "reply",
            description:
              "Answer a message that arrived from Yarvis on this channel. The text is shown to the user in Yarvis.",
            inputSchema: {
              type: "object",
              properties: {
                message_id: {
                  type: "string",
                  description: "The message_id of the channel event you are answering",
                },
                text: { type: "string", description: "Your answer, in plain text" },
              },
              required: ["text"],
            },
          },
        ]
      : [],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "reply" || !env) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool ${req.params.name}` }],
      };
    }
    const args = (req.params.arguments ?? {}) as { message_id?: unknown; text?: unknown };
    const res = await fetch(`${env.baseUrl}/reply`, {
      method: "POST",
      headers: { ...env.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: typeof args.message_id === "string" ? args.message_id : null,
        text: args.text,
      }),
    }).catch((e: unknown) => e as Error);
    if (res instanceof Error || !res.ok) {
      const why = res instanceof Error ? res.message : `Yarvis answered ${res.status}`;
      return { isError: true, content: [{ type: "text", text: `Reply not delivered: ${why}` }] };
    }
    return { content: [{ type: "text", text: "Sent to Yarvis." }] };
  });

  // Events sent before the client finishes initializing are dropped.
  if (env) server.oninitialized = () => void pollForever(server, env);
  await server.connect(new StdioServerTransport());
}
