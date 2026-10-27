import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { saveToken } from "../google/service.ts";
import { createAlarm, listAlarms } from "./service.ts";
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
    const id = new URL(req.url).pathname.split("/").pop();
    if (id !== "standup") return new Response("not found", { status: 404 });
    return Response.json({
      id: "standup",
      summary: "Standup",
      start: { dateTime: meetingStart.toISOString() },
      end: { dateTime: new Date(meetingStart.getTime() + 15 * 60_000).toISOString() },
      hangoutLink: "https://meet.google.com/abc",
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

    const first = (await tools.set_meeting_alarm.execute!({ eventId: "standup" }, opts)) as {
      alreadySet: boolean;
    };
    const second = (await tools.set_meeting_alarm.execute!({ eventId: "standup" }, opts)) as {
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
    const result = (await tools.set_meeting_alarm.execute!({ eventId: "nope" }, opts)) as {
      error?: string;
    };
    expect(result.error).toContain("no calendar event");
  });

  it("won't set an alarm in the past", async () => {
    const tools = buildAlarmTools(db, config);
    const result = (await tools.set_alarm.execute!(
      { label: "late", at: new Date(Date.now() - 60_000).toISOString() },
      opts,
    )) as { error?: string };
    expect(result.error).toBeDefined();
    expect(await listAlarms(db)).toEqual([]);
  });

  it("lets a pass cancel only the alarms it set", async () => {
    const tools = buildAlarmTools(db, config, { unattended: true });
    const fireAt = new Date(Date.now() + 10 * 60_000);
    const users = await createAlarm(db, { label: "mine", fireAt, source: "app" });
    const its = await createAlarm(db, { label: "its", fireAt, source: "heads-down" });

    const refused = (await tools.cancel_alarm.execute!({ id: users.id }, opts)) as {
      error?: string;
    };
    const cancelled = (await tools.cancel_alarm.execute!({ id: its.id }, opts)) as { ok?: true };

    expect(refused.error).toBeDefined();
    expect(cancelled.ok).toBe(true);
    const statuses = Object.fromEntries((await listAlarms(db)).map((a) => [a.label, a.status]));
    expect(statuses).toEqual({ mine: "scheduled", its: "cancelled" });
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
});
