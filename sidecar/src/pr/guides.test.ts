import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { getDb } from "../db/client.ts";
import type { PrGuideStep } from "../db/schema.ts";
import {
  deleteGuide,
  getGuide,
  isStale,
  listGuides,
  saveGuide,
  setGuideProgress,
  sweepStaleGuides,
} from "./guides.ts";
import type { PrRef } from "./types.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };
const other: PrRef = { provider: "github", owner: "o", repo: "r", number: 2 };
const azRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 3 };

const step = (path: string): PrGuideStep => ({
  path,
  startLine: 1,
  endLine: 10,
  explanation: `look at ${path}`,
});

beforeEach(async () => {
  await sql`TRUNCATE pr_guides RESTART IDENTITY`;
});

describe("saveGuide", () => {
  it("stores a guide and reads it back", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a.ts")], title: "Add a" });
    const guide = await getGuide(db, ref);
    expect(guide).toMatchObject({ headSha: "a".repeat(40), title: "Add a", currentStep: 0 });
    expect(guide!.steps).toHaveLength(1);
  });

  // Two competing reading orders for one pull request would be worse than none.
  it("replaces the existing guide rather than accumulating", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a.ts")] });
    await saveGuide(db, { ref, headSha: "b".repeat(40), steps: [step("b.ts"), step("c.ts")] });
    expect(await listGuides(db)).toHaveLength(1);
    const guide = await getGuide(db, ref);
    expect(guide!.headSha).toBe("b".repeat(40));
    expect(guide!.steps).toHaveLength(2);
  });

  // Regenerating produces a different reading order, so a step index into the
  // old one no longer points anywhere meaningful.
  it("resets progress when a guide is regenerated", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a"), step("b"), step("c")] });
    await setGuideProgress(db, ref, 2);
    await saveGuide(db, { ref, headSha: "b".repeat(40), steps: [step("x"), step("y")] });
    expect((await getGuide(db, ref))!.currentStep).toBe(0);
  });

  it("keeps guides for different pull requests apart", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a.ts")] });
    await saveGuide(db, { ref: other, headSha: "b".repeat(40), steps: [step("b.ts")] });
    expect(await listGuides(db)).toHaveLength(2);
    expect((await getGuide(db, other))!.headSha).toBe("b".repeat(40));
  });

  it("stores an azure guide under its own identity", async () => {
    await saveGuide(db, { ref: azRef, headSha: "c".repeat(40), steps: [step("a.ts")] });
    const guide = await getGuide(db, azRef);
    expect(guide).toMatchObject({ refKey: "az:acme/Shop/web/3", provider: "azure" });
  });
});

describe("setGuideProgress", () => {
  beforeEach(async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a"), step("b"), step("c")] });
  });

  it("records how far the reviewer has read", async () => {
    expect((await setGuideProgress(db, ref, 1))!.currentStep).toBe(1);
  });

  // A client that has fallen behind a regeneration would otherwise park
  // progress past the end of a now-shorter guide.
  it("clamps a step past the end of the guide", async () => {
    expect((await setGuideProgress(db, ref, 99))!.currentStep).toBe(2);
  });

  it("clamps a negative step", async () => {
    expect((await setGuideProgress(db, ref, -5))!.currentStep).toBe(0);
  });

  it("reports no guide rather than creating one", async () => {
    expect(await setGuideProgress(db, other, 0)).toBeNull();
  });

  // The sweep keys off this, so an actively-read guide must not look abandoned.
  it("touches the guide so progress counts as activity", async () => {
    const before = (await getGuide(db, ref))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await setGuideProgress(db, ref, 1);
    expect((await getGuide(db, ref))!.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("deleteGuide", () => {
  it("removes the guide and reports that it did", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a.ts")] });
    expect(await deleteGuide(db, ref)).toBe(true);
    expect(await getGuide(db, ref)).toBeNull();
  });

  it("reports nothing removed when there was no guide", async () => {
    expect(await deleteGuide(db, ref)).toBe(false);
  });
});

describe("sweepStaleGuides", () => {
  it("drops guides nothing has touched inside the window", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a.ts")] });
    await sql`UPDATE pr_guides SET updated_at = now() - interval '40 days'`;
    expect(await sweepStaleGuides(db)).toBe(1);
    expect(await getGuide(db, ref)).toBeNull();
  });

  it("leaves a guide that is still being read", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a.ts")] });
    expect(await sweepStaleGuides(db)).toBe(0);
    expect(await getGuide(db, ref)).not.toBeNull();
  });
});

describe("isStale", () => {
  const guide = { headSha: "a".repeat(40) } as Parameters<typeof isStale>[0];

  it("is stale once the pull request has moved on", () => {
    expect(isStale(guide, "b".repeat(40))).toBe(true);
  });

  it("is fresh at the commit it was generated against", () => {
    expect(isStale(guide, "a".repeat(40))).toBe(false);
  });

  // An unreported head commit is not evidence the guide has gone stale, and
  // marking it so would put a warning on every guide the check couldn't run for.
  it("does not call a guide stale when the head is unknown", () => {
    expect(isStale(guide, "")).toBe(false);
  });
});

afterAll(async () => {
  await sql.end();
});
