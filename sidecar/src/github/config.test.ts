import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { DEFAULT_GITHUB_PR_CONFIG, getGithubPrConfig, saveGithubPrConfig } from "./config.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE github_pr_config RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("github pr config", () => {
  it("returns the built-in defaults when nothing is saved", async () => {
    expect(await getGithubPrConfig(db)).toEqual(DEFAULT_GITHUB_PR_CONFIG);
  });

  it("saves and reads back the config", async () => {
    const saved = await saveGithubPrConfig(db, {
      reviewQuery: "is:open is:pr review-requested:@me -is:draft org:acme",
      reviewingLookbackDays: 7,
    });
    expect(saved.reviewQuery).toContain("org:acme");
    expect(saved.reviewingLookbackDays).toBe(7);
    expect(await getGithubPrConfig(db)).toEqual(saved);
  });

  it("keeps a single row across saves (updates in place)", async () => {
    await saveGithubPrConfig(db, { reviewQuery: "is:pr a", reviewingLookbackDays: 10 });
    await saveGithubPrConfig(db, { reviewQuery: "is:pr b", reviewingLookbackDays: 20 });
    const rows = await sql`SELECT count(*)::int AS n FROM github_pr_config`;
    expect(rows[0]!.n).toBe(1);
    expect(await getGithubPrConfig(db)).toEqual({
      reviewQuery: "is:pr b",
      reviewingLookbackDays: 20,
    });
  });
});
