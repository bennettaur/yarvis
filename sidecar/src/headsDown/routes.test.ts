import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { askUser } from "./attention.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

const post = (path: string, body?: unknown) =>
  app.request(`/api/heads-down${path}`, {
    method: "POST",
    headers: jsonAuth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = async (path: string) =>
  (await app.request(`/api/heads-down${path}`, { headers: auth })).json();

let settingsDir: string;
const originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;

beforeEach(async () => {
  await sql`TRUNCATE heads_down_runs, heads_down_messages, heads_down_questions, attention_items, memories, events RESTART IDENTITY CASCADE`;
  settingsDir = mkdtempSync(join(tmpdir(), "heads-down-routes-"));
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterAll(async () => {
  rmSync(settingsDir, { recursive: true, force: true });
  process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await sql.end();
});

describe("/api/heads-down", () => {
  it("turns heads-down mode on and off", async () => {
    expect((await post("/start", { focus: "ship billing" })).status).toBe(200);
    expect(await get("")).toMatchObject({ run: { focus: "ship billing", status: "active" } });

    await askUser(db, { kind: "question", question: "Which repo?" });
    await post("/stop");
    expect(await get("")).toMatchObject({ run: null });
    // Nothing is left in the bell asking for an answer no pass will read.
    expect(await get("/questions")).toEqual([]);
    const items = await sql`SELECT status FROM attention_items`;
    expect(items.map((r) => r.status)).toEqual(["resolved"]);
  });

  it("takes a message for the next pass, and refuses an empty one", async () => {
    expect((await post("/messages", { body: "Send Alex the PR link" })).status).toBe(201);
    expect((await post("/messages", { body: "  " })).status).toBe(400);
    expect(await get("/messages")).toEqual([
      expect.objectContaining({ body: "Send Alex the PR link", seenAt: null }),
    ]);
  });

  it("answers a question once, and clears it from the attention bell", async () => {
    const question = await askUser(db, {
      kind: "question",
      question: "Where should I ask for review?",
      options: ["#billing-reviews"],
    });

    expect(
      (await post(`/questions/${question.id}/answer`, { choice: "#billing-reviews" })).status,
    ).toBe(200);
    expect(
      (await post(`/questions/${question.id}/answer`, { choice: "#billing-reviews" })).status,
    ).toBe(409);
    expect(await get("/questions")).toEqual([]);
    const items = await sql`SELECT status, nav_target FROM attention_items`;
    expect([...items]).toEqual([
      expect.objectContaining({ status: "resolved", nav_target: { type: "heads-down" } }),
    ]);
  });

  it("saves working hours, and refuses a min sleep above the max", async () => {
    const valid = {
      minSleepMinutes: 5,
      maxSleepMinutes: 120,
      idleSleepMinutes: 60,
      workingHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      userAwayAfterMinutes: 120,
      provider: null,
      model: null,
    };
    const put = (body: unknown) =>
      app.request("/api/heads-down/config", {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify(body),
      });

    expect((await put({ ...valid, workingHours: null })).status).toBe(200);
    expect(await get("/config")).toMatchObject({ workingHours: null });
    expect((await put({ ...valid, minSleepMinutes: 200 })).status).toBe(400);
    expect(
      (await put({ ...valid, workingHours: { ...valid.workingHours, start: "9am" } })).status,
    ).toBe(400);
  });

  it("answers 404 for a pass that doesn't exist", async () => {
    const res = await app.request("/api/heads-down/passes/00000000-0000-4000-8000-000000000000", {
      headers: auth,
    });
    expect(res.status).toBe(404);
  });
});
