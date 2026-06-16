import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import {
  addStar,
  createFilter,
  deleteFilter,
  listFilters,
  listStars,
  removeStar,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE azure_devops_filters, azure_devops_stars RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("azure service", () => {
  it("creates, lists, and deletes saved filters", async () => {
    const filter = await createFilter(db, "Mine", "mine", null);
    expect((await listFilters(db)).length).toBe(1);
    expect(await deleteFilter(db, filter.id)).toBe(true);
    expect((await listFilters(db)).length).toBe(0);
  });

  it("stars a PR idempotently and unstars it", async () => {
    const pr = { org: "acme", project: "Shop", repo: "web", prId: 7, title: "Feat", url: "u" };
    await addStar(db, pr);
    await addStar(db, pr); // duplicate ignored by the unique index
    expect((await listStars(db)).length).toBe(1);

    expect(await removeStar(db, "acme", "Shop", "web", 7)).toBe(true);
    expect((await listStars(db)).length).toBe(0);
  });
});
