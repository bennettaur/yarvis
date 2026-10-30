import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import {
  type ActivityEvent,
  hasActivitySubscribers,
  publishActivity,
  subscribeActivity,
} from "./hub.ts";
import { createActivityIngestRoutes, createActivityRoutes } from "./routes.ts";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const SESSION_KEY = `ws-claude:${WORKSPACE_ID}`;

const config = {
  token: "test-token",
  attentionToken: "test-attention-token",
  databaseUrl: undefined,
} as Config;

const sessionToken = (key: string) =>
  createHmac("sha256", config.token).update(`session:${key}`).digest("hex");

let unsubscribe: (() => void) | undefined;
afterEach(() => unsubscribe?.());

function watch(): ActivityEvent[] {
  const seen: ActivityEvent[] = [];
  unsubscribe = subscribeActivity((event) => seen.push(event));
  return seen;
}

function ingest(
  body: unknown,
  { key = SESSION_KEY, token = sessionToken(SESSION_KEY), workspaceId = WORKSPACE_ID } = {},
) {
  return createActivityIngestRoutes(config).request(`/?workspaceId=${workspaceId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.attentionToken}`,
      "Content-Type": "application/json",
      "X-Yarvis-Session-Key": key,
      "X-Yarvis-Session-Token": token,
    },
    body: JSON.stringify(body),
  });
}

const preToolUse = {
  hook_event_name: "PreToolUse",
  session_id: "d8cb83ea-8ef9-42b0-95b2-bf4602c282bc",
  tool_name: "Read",
  tool_input: { file_path: "/repo/README.md" },
};

describe("activity ingest", () => {
  it("publishes a session's hook as a Claude event", async () => {
    const seen = watch();
    const res = await ingest(preToolUse);
    expect(res.status).toBe(204);
    expect(seen).toEqual([
      { origin: "claude", type: "read", source: "claude:d8cb", label: "Read README.md" },
    ]);
  });

  it("refuses the ingest token alone", async () => {
    const res = await createActivityIngestRoutes(config).request(`/?workspaceId=${WORKSPACE_ID}`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: JSON.stringify(preToolUse),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a session token minted for another terminal", async () => {
    const seen = watch();
    const res = await ingest(preToolUse, { token: sessionToken("ws-claude:other") });
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("refuses a session reporting for another workspace", async () => {
    const res = await ingest(preToolUse, {
      workspaceId: "22222222-2222-2222-2222-222222222222",
    });
    expect(res.status).toBe(400);
  });

  it("refuses a malformed hook while a page is watching, and publishes nothing", async () => {
    const seen = watch();
    expect((await ingest({ nope: true })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("accepts a hook the page doesn't draw without publishing it", async () => {
    const seen = watch();
    expect((await ingest({ hook_event_name: "SessionEnd" })).status).toBe(204);
    expect(seen).toEqual([]);
  });

  it("does nothing while no page is watching", async () => {
    // A malformed body still answers 204: nothing is parsed without a viewer.
    expect((await ingest({ nope: true })).status).toBe(204);
  });
});

describe("activity stream", () => {
  it("opens with a ping, forwards published events, and stops listening once closed", async () => {
    // A real server, so the client hanging up aborts the request the way it does in the app.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: createActivityRoutes().fetch,
    });
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/stream`, { signal: abort.signal });
    const reader = res.body!.getReader();
    try {
      const decoder = new TextDecoder();
      const next = async () => decoder.decode((await reader.read()).value);

      expect(await next()).toContain('"type":"ping"');
      const event: ActivityEvent = {
        origin: "yarvis",
        type: "done",
        source: "chat",
        label: "turn complete",
      };
      publishActivity(event);
      expect(await next()).toContain(JSON.stringify({ type: "event", event }));
      expect(hasActivitySubscribers()).toBe(true);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => {});
    }
    // Publishers skip all work once nobody is subscribed, so a leaked listener would cost forever.
    await Bun.sleep(100);
    expect(hasActivitySubscribers()).toBe(false);
    server.stop(true);
  });
});

describe("activity ingest, mounted in the app", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
  const sql = postgres(url, { max: 1 });
  const app = createApp({
    port: 0,
    token: config.token,
    tokenGenerated: false,
    attentionToken: config.attentionToken,
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl: url,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  });

  beforeEach(async () => {
    await sql`TRUNCATE workspaces RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await sql.end();
  });

  const post = (workspaceId = WORKSPACE_ID) =>
    app.request(`/ingest/activity?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.attentionToken}`,
        "Content-Type": "application/json",
        "X-Yarvis-Session-Key": `ws-claude:${workspaceId}`,
        "X-Yarvis-Session-Token": sessionToken(`ws-claude:${workspaceId}`),
      },
      body: JSON.stringify(preToolUse),
    });

  it("names a session's node after its workspace", async () => {
    await sql`INSERT INTO workspaces (id, name, slug, status, root_path)
              VALUES (${WORKSPACE_ID}, 'visualizer', 'visualizer', 'active', '/tmp/ws')`;
    const seen = watch();
    expect((await post()).status).toBe(204);
    expect(seen.map((e) => e.source)).toEqual(["visualizer:d8cb"]);
  });

  it("falls back to a generic name for a workspace it can't find", async () => {
    const seen = watch();
    // A workspace of its own: names are cached for a minute, so another test's would be reused.
    expect((await post("33333333-3333-3333-3333-333333333333")).status).toBe(204);
    expect(seen.map((e) => e.source)).toEqual(["claude:d8cb"]);
  });
});
