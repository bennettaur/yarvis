import { beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { getDb } from "../db/client.ts";
import {
  deleteInsight,
  getInsight,
  listInsights,
  markInsightPosted,
  saveInsight,
} from "./insights.ts";
import { type PrRef, parseRefKey, refKey } from "./types.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };
const other: PrRef = { provider: "github", owner: "o", repo: "r", number: 2 };
const azRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 3 };

const insight = (over: Partial<Parameters<typeof saveInsight>[1]> = {}) => ({
  ref,
  path: "src/a.ts",
  startLine: 10,
  endLine: 12,
  headSha: "a".repeat(40),
  question: "why the guard?",
  answer: "it stops a null slipping through",
  ...over,
});

beforeEach(async () => {
  await sql`TRUNCATE pr_insights`;
});

describe("saveInsight", () => {
  it("stores an answer against its lines", async () => {
    const row = await saveInsight(db, insight());
    expect(row).toMatchObject({
      refKey: "gh:o/r/1",
      provider: "github",
      path: "src/a.ts",
      startLine: 10,
      endLine: 12,
      answer: "it stops a null slipping through",
    });
    // Local until the reviewer chooses to share it.
    expect(row.postedAt).toBeNull();
  });

  // Unlike a guide, several insights coexist on the same lines — asking a
  // follow-up shouldn't overwrite the answer that prompted it.
  it("keeps every insight rather than replacing", async () => {
    await saveInsight(db, insight());
    await saveInsight(db, insight({ question: "and what calls it?" }));
    expect(await listInsights(db, ref)).toHaveLength(2);
  });

  it("keeps insights for different pull requests apart", async () => {
    await saveInsight(db, insight());
    await saveInsight(db, insight({ ref: other }));
    expect(await listInsights(db, ref)).toHaveLength(1);
    expect(await listInsights(db, other)).toHaveLength(1);
  });

  it("stores an azure insight under its own identity", async () => {
    const row = await saveInsight(db, insight({ ref: azRef }));
    expect(row.refKey).toBe("az:acme/Shop/web/3");
  });
});

describe("listInsights", () => {
  it("returns the newest first", async () => {
    await saveInsight(db, insight({ question: "first" }));
    await new Promise((r) => setTimeout(r, 5));
    await saveInsight(db, insight({ question: "second" }));
    expect((await listInsights(db, ref)).map((i) => i.question)).toEqual(["second", "first"]);
  });

  it("is empty for a pull request with none", async () => {
    expect(await listInsights(db, ref)).toEqual([]);
  });
});

describe("markInsightPosted", () => {
  it("stamps when the insight was shared", async () => {
    const row = await saveInsight(db, insight());
    const posted = await markInsightPosted(db, row.id);
    expect(posted!.postedAt).toBeInstanceOf(Date);
  });

  it("reports nothing for an id that is not there", async () => {
    expect(await markInsightPosted(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("deleteInsight", () => {
  it("removes one and leaves the rest", async () => {
    const first = await saveInsight(db, insight({ question: "one" }));
    await saveInsight(db, insight({ question: "two" }));
    expect(await deleteInsight(db, first.id)).toBe(true);
    expect(await getInsight(db, first.id)).toBeNull();
    expect(await listInsights(db, ref)).toHaveLength(1);
  });

  it("reports nothing removed for an unknown id", async () => {
    expect(await deleteInsight(db, "00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

describe("parseRefKey", () => {
  // A stored insight carries only the key, so posting it back to the provider
  // depends on this being the exact inverse of `refKey`.
  it("round-trips a github ref", () => {
    expect(parseRefKey(refKey(ref))).toEqual(ref);
  });

  it("round-trips an azure ref", () => {
    expect(parseRefKey(refKey(azRef))).toEqual(azRef);
  });

  it("rejects anything that does not parse", () => {
    expect(parseRefKey("gh:o/r")).toBeNull();
    expect(parseRefKey("gh:o/r/notanumber")).toBeNull();
    expect(parseRefKey("az:acme/Shop/web")).toBeNull();
    expect(parseRefKey("something-else")).toBeNull();
    expect(parseRefKey("")).toBeNull();
  });

  // A half-built ref would fail somewhere downstream instead of here.
  it("rejects a key with an empty component", () => {
    expect(parseRefKey("gh://r/1")).toBeNull();
    expect(parseRefKey("az:acme//web/3")).toBeNull();
  });
});
