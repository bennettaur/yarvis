import { afterAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { SESSION_KEY_HEADER, SESSION_TOKEN_HEADER } from "../workspaces/agentSessions.ts";
import { ChannelHub } from "./hub.ts";
import { CHANNEL_RELAY_ARG } from "./relay.ts";
import { createChannelRoutes } from "./routes.ts";
import { agentCommandLoadsChannel, sendOverChannel } from "./send.ts";

const config = {
  token: "test-token",
  attentionToken: "test-attention-token",
} as Config;

const KEY = "ws-claude:11111111-1111-4111-8111-111111111111";

/** The token the core puts in a PTY's environment (`session_token` in pty.rs). */
const tokenFor = (sessionKey: string) =>
  createHmac("sha256", config.token).update(`session:${sessionKey}`).digest("hex");

function appFor(hub: ChannelHub) {
  const app = new Hono();
  app.route("/ingest/channel", createChannelRoutes(config, hub));
  return app;
}

const headersFor = (sessionKey: string, token = tokenFor(sessionKey)) => ({
  Authorization: `Bearer ${config.attentionToken}`,
  [SESSION_KEY_HEADER]: sessionKey,
  [SESSION_TOKEN_HEADER]: token,
});

describe("channel routes", () => {
  it("refuses a relay holding another terminal's session token", async () => {
    const hub = new ChannelHub();
    const res = await appFor(hub).request("/ingest/channel/next", {
      headers: headersFor(KEY, tokenFor("ws-claude:22222222-2222-4222-8222-222222222222")),
    });
    expect(res.status).toBe(403);
    expect(hub.isConnected(KEY)).toBe(false);
  });

  it("refuses a request without the ingest token", async () => {
    const res = await appFor(new ChannelHub()).request("/ingest/channel/next", {
      headers: { ...headersFor(KEY), Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("delivers a message to its own terminal's poll and records the reply", async () => {
    const hub = new ChannelHub();
    const app = appFor(hub);
    const poll = app.request("/ingest/channel/next", { headers: headersFor(KEY) });
    // Let the poll register before sending.
    await Bun.sleep(10);
    const sent = hub.send(KEY, "what are you working on?");
    const { messages } = (await (await poll).json()) as { messages: unknown[] };
    expect(messages).toEqual([sent!]);

    const reply = await app.request("/ingest/channel/reply", {
      method: "POST",
      headers: { ...headersFor(KEY), "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: sent!.id, text: "fixing the flaky test" }),
    });
    expect(reply.status).toBe(204);
    expect(hub.replies(KEY, sent!.id).map((r) => r.text)).toEqual(["fixing the flaky test"]);
  });
});

describe("agentCommandLoadsChannel", () => {
  it("needs the development-channels flag naming the relay", () => {
    expect(
      agentCommandLoadsChannel(
        "claude --permission-mode auto --dangerously-load-development-channels server:yarvis-channel",
      ),
    ).toBe(true);
    expect(agentCommandLoadsChannel("claude --permission-mode auto")).toBe(false);
    expect(agentCommandLoadsChannel("claude --channels server:yarvis-channel")).toBe(false);
    expect(agentCommandLoadsChannel(null)).toBe(false);
  });
});

describe("sendOverChannel", () => {
  it("leaves the message for the PTY when channels are switched off", async () => {
    const hub = new ChannelHub();
    void hub.next(KEY);
    expect(await sendOverChannel(KEY, "hi", { hub, enabled: async () => false })).toBeNull();
  });

  it("sends when switched on and a relay is polling", async () => {
    const hub = new ChannelHub();
    const poll = hub.next(KEY);
    const sent = await sendOverChannel(KEY, "hi", { hub, enabled: async () => true });
    expect(await poll).toEqual([sent!]);
  });
});

describe("channel relay", () => {
  const hub = new ChannelHub();
  const app = appFor(hub);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  const clients: Client[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    server.stop(true);
  });

  it("pushes a message into the session as a channel event and posts its reply", async () => {
    const client = new Client({ name: "fake-claude-code", version: "0" });
    clients.push(client);
    const events: { content: string; meta?: Record<string, string> }[] = [];
    client.setNotificationHandler(
      z.object({
        method: z.literal("notifications/claude/channel"),
        params: z.object({
          content: z.string(),
          meta: z.record(z.string(), z.string()).optional(),
        }),
      }),
      (n) => {
        events.push(n.params);
      },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(import.meta.dir, "../main.ts"), CHANNEL_RELAY_ARG],
        env: {
          PATH: process.env.PATH ?? "",
          YARVIS_SIDECAR_PORT: String(server.port),
          YARVIS_ATTENTION_TOKEN: config.attentionToken,
          YARVIS_SESSION_KEY: KEY,
          YARVIS_SESSION_TOKEN: tokenFor(KEY),
        },
      }),
    );

    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });

    const deadline = Date.now() + 5_000;
    while (!hub.isConnected(KEY) && Date.now() < deadline) await Bun.sleep(20);
    const sent = hub.send(KEY, "summarize what you changed");
    expect(sent).not.toBeNull();
    while (events.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(events).toEqual([
      { content: "summarize what you changed", meta: { message_id: sent!.id } },
    ]);

    const result = await client.callTool({
      name: "reply",
      arguments: { message_id: sent!.id, text: "I fixed the parser" },
    });
    expect(result.isError).toBeFalsy();
    expect(hub.replies(KEY, sent!.id).map((r) => r.text)).toEqual(["I fixed the parser"]);
  });

  it("offers no tools to a Claude Code started outside a Yarvis terminal", async () => {
    const client = new Client({ name: "fake-claude-code", version: "0" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(import.meta.dir, "../main.ts"), CHANNEL_RELAY_ARG],
        env: { PATH: process.env.PATH ?? "" },
      }),
    );
    expect((await client.listTools()).tools).toEqual([]);
  });
});
