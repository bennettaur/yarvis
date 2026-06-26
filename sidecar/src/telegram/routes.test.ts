import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import { securityLog } from "./securityLog.ts";

function app(): ReturnType<typeof createApp> {
  return createApp({
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    allowedOrigins: null,
    databaseUrl: "postgres://localhost/unused",
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  });
}

const auth = { Authorization: "Bearer test-token" };

describe("GET /api/telegram/security-events", () => {
  it("requires the bearer token", async () => {
    const res = await app().request("/api/telegram/security-events");
    expect(res.status).toBe(401);
  });

  it("returns events newer than the `since` sequence", async () => {
    // securityLog is a process singleton; use a unique chat id and read the seq
    // boundary from the response rather than asserting absolute counts.
    const chat = 7_000 + Math.floor(performance.now());
    securityLog.add("unlock", chat, 1000);
    const all = (await (
      await app().request("/api/telegram/security-events", { headers: auth })
    ).json()) as { events: { chatId: number; seq: number; type: string }[] };
    const mine = all.events.filter((e) => e.chatId === chat);
    expect(mine).toHaveLength(1);
    const cursor = mine[0]!.seq;

    securityLog.add("failed", chat, 1001);
    const since = (await (
      await app().request(`/api/telegram/security-events?since=${cursor}`, { headers: auth })
    ).json()) as { events: { chatId: number; type: string }[] };
    const newer = since.events.filter((e) => e.chatId === chat);
    expect(newer.map((e) => e.type)).toEqual(["failed"]);
  });

  it("treats a missing or non-numeric `since` as 0 (returns all)", async () => {
    const res = await app().request("/api/telegram/security-events?since=abc", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });
});
