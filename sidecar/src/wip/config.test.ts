import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { DEFAULT_WIP_CONFIG, getWipConfig, saveWipConfig } from "./config.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE wip_config RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("wip config", () => {
  it("returns all-on defaults when nothing is saved", async () => {
    expect(await getWipConfig(db)).toEqual(DEFAULT_WIP_CONFIG);
  });

  it("saves and reads back the config", async () => {
    const saved = await saveWipConfig(db, {
      sources: { myPrs: false, starredPrs: true, issues: true, tasks: false, workspaces: true },
      issueLabels: ["in-progress", "doing"],
    });
    expect(saved.sources.myPrs).toBe(false);
    expect(saved.issueLabels).toEqual(["in-progress", "doing"]);
    expect(await getWipConfig(db)).toEqual(saved);
  });

  it("keeps a single row across saves (updates in place)", async () => {
    await saveWipConfig(db, { ...DEFAULT_WIP_CONFIG, issueLabels: ["a"] });
    await saveWipConfig(db, { ...DEFAULT_WIP_CONFIG, issueLabels: ["b"] });
    const rows = await sql`SELECT count(*)::int AS n FROM wip_config`;
    expect(rows[0]!.n).toBe(1);
    expect((await getWipConfig(db)).issueLabels).toEqual(["b"]);
  });

  it("backfills a missing source key from defaults", async () => {
    // Simulate a row written before a new source key existed.
    await sql`INSERT INTO wip_config (sources, issue_labels)
              VALUES (${sql.json({ myPrs: false })}, ${sql.json([])})`;
    const config = await getWipConfig(db);
    expect(config.sources.myPrs).toBe(false); // saved value wins
    expect(config.sources.workspaces).toBe(true); // missing key defaults on
  });
});
