import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import { newAttentionState } from "../chat/attentionTools.ts";
import { builtinToolFamilies } from "../chat/builtinTools.ts";
import { newUntrustedReads } from "../chat/destructiveTools.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { saveToken } from "../google/service.ts";
import { cancelAlarm, createAlarm, listAlarms } from "./service.ts";
import { buildAlarmTools } from "./tools.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const opts = { toolCallId: "test", messages: [] } as never;

const meetingStart = new Date(Date.now() + 60 * 60_000);
const calendar = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    const id = new URL(req.url).pathname.split("/").pop() ?? "";
    // "standup" has no guest list; the others carry the user's own reply.
    const replies: Record<string, string | null> = {
      standup: null,
      accepted: "accepted",
      maybe: "tentative",
      declined: "declined",
    };
    if (!(id in replies)) return new Response("not found", { status: 404 });
    const reply = replies[id];
    return Response.json({
      id,
      summary: id === "standup" ? "Standup" : `Planning (${id})`,
      start: { dateTime: meetingStart.toISOString() },
      end: { dateTime: new Date(meetingStart.getTime() + 15 * 60_000).toISOString() },
      hangoutLink: "https://meet.google.com/abc",
      attendees: reply
        ? [{ email: "me@example.com", self: true, responseStatus: reply }]
        : undefined,
    });
  },
});

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: { googleClientId: "cid", googleClientSecret: "secret" },
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  endpoints: {
    googleCalendar: `http://127.0.0.1:${calendar.port}`,
    googleToken: `http://127.0.0.1:${calendar.port}/token`,
  },
};

beforeEach(async () => {
  await sql`TRUNCATE alarms, google_tokens`;
  await saveToken(db, { accessToken: "tok", expiresAt: Date.now() + 60 * 60_000 });
});

afterAll(async () => {
  calendar.stop(true);
  await sql.end();
});

describe("alarm tools", () => {
  it("sets a meeting alarm a minute before, once", async () => {
    const tools = buildAlarmTools(db, config, { unattended: true });

    const first = (await tools.set_meeting_alarm!.execute!({ eventId: "standup" }, opts)) as {
      alreadySet: boolean;
    };
    const second = (await tools.set_meeting_alarm!.execute!({ eventId: "standup" }, opts)) as {
      alreadySet: boolean;
    };

    expect(first.alreadySet).toBe(false);
    expect(second.alreadySet).toBe(true);
    const [alarm] = await listAlarms(db);
    expect(alarm?.label).toBe("Meeting: Standup");
    expect(alarm?.fireAt.getTime()).toBe(meetingStart.getTime() - 60_000);
    expect(alarm?.meetLink).toBe("https://meet.google.com/abc");
    expect(alarm?.source).toBe("heads-down");
  });

  it("reports a calendar event that doesn't exist", async () => {
    const tools = buildAlarmTools(db, config);
    const result = (await tools.set_meeting_alarm!.execute!({ eventId: "nope" }, opts)) as {
      error?: string;
    };
    expect(result.error).toContain("no calendar event");
  });

  it("won't set an alarm in the past", async () => {
    const tools = buildAlarmTools(db, config);
    const result = (await tools.set_alarm!.execute!(
      { label: "late", at: new Date(Date.now() - 60_000).toISOString() },
      opts,
    )) as { error?: string };
    expect(result.error).toBeDefined();
    expect(await listAlarms(db)).toEqual([]);
  });

  it("doesn't set a meeting alarm again after the user cancelled it", async () => {
    const tools = buildAlarmTools(db, config, { unattended: true });
    const first = (await tools.set_meeting_alarm!.execute!({ eventId: "standup" }, opts)) as {
      id: string;
    };
    await cancelAlarm(db, first.id);

    const again = (await tools.set_meeting_alarm!.execute!({ eventId: "standup" }, opts)) as {
      alreadySet: boolean;
      status: string;
    };

    expect(again).toMatchObject({ alreadySet: true, status: "cancelled" });
    expect(await listAlarms(db)).toHaveLength(1);
  });

  it("in a pass, sets a meeting alarm only for a meeting the user accepted", async () => {
    const tools = buildAlarmTools(db, config, { unattended: true });
    const set = async (eventId: string) =>
      (await tools.set_meeting_alarm!.execute!({ eventId }, opts)) as { error?: string };

    expect((await set("maybe")).error).toContain("ask_user");
    expect((await set("declined")).error).toContain("declined");
    expect((await set("accepted")).error).toBeUndefined();
    expect((await listAlarms(db)).map((a) => a.label)).toEqual(["Meeting: Planning (accepted)"]);
  });

  it("in a chat, won't set an alarm for a meeting the user declined", async () => {
    const tools = buildAlarmTools(db, config);
    const declined = (await tools.set_meeting_alarm!.execute!({ eventId: "declined" }, opts)) as {
      error?: string;
    };
    const maybe = (await tools.set_meeting_alarm!.execute!({ eventId: "maybe" }, opts)) as {
      error?: string;
    };

    expect(declined.error).toContain("declined");
    expect(maybe.error).toBeUndefined();
  });

  it("gives a pass no way to set a free-form alarm or cancel one", () => {
    const deps = {
      db,
      config,
      sessionId: "s",
      memory: undefined as never,
      attention: newAttentionState(),
      remoteControl: false,
      untrustedReads: newUntrustedReads(),
    };
    const pass = builtinToolFamilies({ ...deps, atTheApp: false, unattended: true }).alarms!;
    const chat = builtinToolFamilies({ ...deps, atTheApp: true }).alarms!;

    expect(Object.keys(pass).sort()).toEqual(["list_alarms", "set_meeting_alarm"]);
    expect(Object.keys(chat).sort()).toEqual([
      "cancel_alarm",
      "list_alarms",
      "set_alarm",
      "set_meeting_alarm",
    ]);
  });

  it("cancels an alarm in a chat, but not one already dealt with", async () => {
    const tools = buildAlarmTools(db, config);
    const fireAt = new Date(Date.now() + 10 * 60_000);
    const alarm = await createAlarm(db, { label: "mine", fireAt, source: "app" });

    const first = (await tools.cancel_alarm!.execute!({ id: alarm.id }, opts)) as { ok?: true };
    const again = (await tools.cancel_alarm!.execute!({ id: alarm.id }, opts)) as {
      error?: string;
    };

    expect(first.ok).toBe(true);
    expect(again.error).toContain("cancelled");
  });
});

describe("/api/alarms", () => {
  const app = createApp(config);
  const auth = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

  it("creates, lists and acknowledges an alarm", async () => {
    const fireAtMs = Date.now() + 5 * 60_000;
    const created = await app.request("/api/alarms", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ label: "Tea", fireAtMs }),
    });
    expect(created.status).toBe(201);
    const alarm = (await created.json()) as { id: string; fireAtMs: number; source: string };
    expect(alarm.fireAtMs).toBe(fireAtMs);
    expect(alarm.source).toBe("app");
    await sql`UPDATE alarms SET status = 'fired' WHERE id = ${alarm.id}`;

    const ack = await app.request(`/api/alarms/${alarm.id}/acknowledge`, {
      method: "POST",
      headers: auth,
    });
    expect(((await ack.json()) as { status: string }).status).toBe("acknowledged");

    const list = (await (await app.request("/api/alarms", { headers: auth })).json()) as {
      id: string;
    }[];
    expect(list.map((a) => a.id)).toEqual([alarm.id]);
  });

  it("rejects a snooze with no minutes and an unknown alarm", async () => {
    const bad = await app.request("/api/alarms/00000000-0000-4000-8000-000000000000/snooze", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    const missing = await app.request("/api/alarms/00000000-0000-4000-8000-000000000000/snooze", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ minutes: 5 }),
    });
    expect(missing.status).toBe(404);
  });

  it("turns away a snooze or acknowledge for an alarm that isn't ringing", async () => {
    const alarm = await createAlarm(db, {
      label: "later",
      fireAt: new Date(Date.now() + 10 * 60_000),
      source: "app",
    });

    const ack = await app.request(`/api/alarms/${alarm.id}/acknowledge`, {
      method: "POST",
      headers: auth,
    });
    const snooze = await app.request(`/api/alarms/${alarm.id}/snooze`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ minutes: 5 }),
    });

    expect(ack.status).toBe(409);
    expect(snooze.status).toBe(409);
  });

  it("cancels an upcoming alarm and snoozes a ringing one", async () => {
    const upcoming = await createAlarm(db, {
      label: "upcoming",
      fireAt: new Date(Date.now() + 10 * 60_000),
      source: "app",
    });
    const ringing = await createAlarm(db, {
      label: "ringing",
      fireAt: new Date(Date.now() - 60_000),
      source: "app",
    });
    await sql`UPDATE alarms SET status = 'fired' WHERE id = ${ringing.id}`;

    const cancel = await app.request(`/api/alarms/${upcoming.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    const snooze = await app.request(`/api/alarms/${ringing.id}/snooze`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ minutes: 5 }),
    });

    expect(((await cancel.json()) as { status: string }).status).toBe("cancelled");
    const snoozed = (await snooze.json()) as { status: string; fireAtMs: number };
    expect(snoozed.status).toBe("scheduled");
    expect(snoozed.fireAtMs).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  it("answers 404 for an id that isn't a UUID", async () => {
    const res = await app.request("/api/alarms/not-an-id/cancel", {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it("rejects an alarm with no label, a bad time, or a link that isn't a web link", async () => {
    const post = (body: unknown) =>
      app.request("/api/alarms", { method: "POST", headers: auth, body: JSON.stringify(body) });
    const fireAtMs = Date.now() + 60_000;

    expect((await post({ label: "", fireAtMs })).status).toBe(400);
    expect((await post({ label: "Tea", fireAtMs: -5 })).status).toBe(400);
    expect((await post({ label: "Tea", fireAtMs, meetLink: "javascript:alert(1)" })).status).toBe(
      400,
    );
    expect(await listAlarms(db)).toEqual([]);
  });
});
