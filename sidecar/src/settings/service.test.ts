import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { CLAUDE_COMMAND_KEY, getSetting, setSetting } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  // Only truncate if we can connect. If not, this test might skip or fail gracefully.
  try {
    await sql`TRUNCATE app_settings RESTART IDENTITY CASCADE`;
  } catch {
    // skip
  }
});

afterAll(async () => {
  await sql.end();
});

describe("settings service", () => {
  it("returns null for unknown keys", async () => {
    try {
      const val = await getSetting(db, "unknown");
      expect(val).toBeNull();
    } catch (e) {
      if (e instanceof Error && e.message.includes("ECONNREFUSED")) {
        console.warn("Skipping DB test due to ECONNREFUSED");
        return;
      }
      throw e;
    }
  });

  it("can set and get a setting", async () => {
    try {
      await setSetting(db, CLAUDE_COMMAND_KEY, "custom-claude");
      const val = await getSetting(db, CLAUDE_COMMAND_KEY);
      expect(val).toBe("custom-claude");
    } catch (e) {
      if (e instanceof Error && e.message.includes("ECONNREFUSED")) {
        console.warn("Skipping DB test due to ECONNREFUSED");
        return;
      }
      throw e;
    }
  });

  it("can update an existing setting", async () => {
    try {
      await setSetting(db, "test", "v1");
      await setSetting(db, "test", "v2");
      const val = await getSetting(db, "test");
      expect(val).toBe("v2");
    } catch (e) {
      if (e instanceof Error && e.message.includes("ECONNREFUSED")) {
        console.warn("Skipping DB test due to ECONNREFUSED");
        return;
      }
      throw e;
    }
  });
});
