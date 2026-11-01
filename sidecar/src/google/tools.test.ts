import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { saveToken } from "./service.ts";
import { buildCalendarTools } from "./tools.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const opts = { toolCallId: "test", messages: [] } as never;

let lastQuery: URLSearchParams | null = null;
const calendar = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    lastQuery = new URL(req.url).searchParams;
    return Response.json({
      items: [
        {
          id: "retro",
          summary: "Retro",
          start: { dateTime: "2026-10-31T15:00:00Z" },
          end: { dateTime: "2026-10-31T15:30:00Z" },
          attachments: [
            {
              title: "Notes by Gemini",
              fileUrl: "https://docs.google.com/document/d/abc",
              mimeType: "application/vnd.google-apps.document",
            },
          ],
        },
      ],
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
  lastQuery = null;
  await sql`TRUNCATE google_tokens`;
  await saveToken(db, { accessToken: "tok", expiresAt: Date.now() + 60 * 60_000 });
});

afterAll(async () => {
  calendar.stop(true);
  await sql.end();
});

describe("list_calendar_events", () => {
  const list = async (input: Record<string, unknown>) =>
    (await buildCalendarTools(db, config).list_calendar_events.execute!(input as never, opts)) as {
      events: { attachments: unknown[] }[];
    };
  const daysBack = () => {
    const timeMin = Date.parse(lastQuery?.get("timeMin") ?? "");
    return (Date.now() - timeMin) / (24 * 60 * 60_000);
  };

  it("starts from now unless asked to look back, and returns each event's attached notes", async () => {
    const { events } = await list({});
    expect(daysBack()).toBeLessThan(0.01);
    expect(events[0]?.attachments).toEqual([
      {
        title: "Notes by Gemini",
        url: "https://docs.google.com/document/d/abc",
        mimeType: "application/vnd.google-apps.document",
      },
    ]);

    await list({ pastDays: 1 });
    expect(daysBack()).toBeCloseTo(1, 2);
  });
});
