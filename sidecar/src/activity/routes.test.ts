import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { Config } from "../config.ts";
import { type ActivityEvent, publishActivity, subscribeActivity } from "./hub.ts";
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

  it("does nothing while no page is watching", async () => {
    // A malformed body still answers 204: nothing is parsed without a viewer.
    expect((await ingest({ nope: true })).status).toBe(204);
  });
});

describe("activity stream", () => {
  it("opens with a ping and forwards published events", async () => {
    const abort = new AbortController();
    const res = await createActivityRoutes().request("/stream", { signal: abort.signal });
    const reader = res.body!.getReader();
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
    abort.abort();
  });
});
