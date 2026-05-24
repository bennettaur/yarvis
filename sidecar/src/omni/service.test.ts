import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { deleteLayout, getLayout, listLayouts, saveLayout } from "./service.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const sampleSpec = {
  root: "root",
  elements: {
    root: { type: "Row", props: {}, children: ["tasks"] },
    tasks: { type: "Tasks", props: {}, children: [] },
  },
};

beforeEach(async () => {
  await sql`TRUNCATE omni_layouts RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("omni layout service", () => {
  it("saves and reads back a layout", async () => {
    const saved = await saveLayout(db, "My dashboard", sampleSpec);
    expect(saved.id).toBeString();
    expect(saved.name).toBe("My dashboard");

    const fetched = await getLayout(db, saved.id);
    expect(fetched?.spec).toEqual(sampleSpec);
  });

  it("upserts by name instead of duplicating", async () => {
    const first = await saveLayout(db, "Daily", sampleSpec);
    const updatedSpec = { root: "root", elements: { root: { type: "Chat", props: {}, children: [] } } };
    const second = await saveLayout(db, "Daily", updatedSpec);

    expect(second.id).toBe(first.id);
    const all = await listLayouts(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.spec).toEqual(updatedSpec);
  });

  it("orders layouts by most recently updated", async () => {
    await saveLayout(db, "Older", sampleSpec);
    await saveLayout(db, "Newer", sampleSpec);
    const all = await listLayouts(db);
    expect(all.map((l) => l.name)).toEqual(["Newer", "Older"]);
  });

  it("deletes a layout", async () => {
    const saved = await saveLayout(db, "Temp", sampleSpec);
    expect(await deleteLayout(db, saved.id)).toBe(true);
    expect(await getLayout(db, saved.id)).toBeNull();
    expect(await deleteLayout(db, saved.id)).toBe(false);
  });
});
