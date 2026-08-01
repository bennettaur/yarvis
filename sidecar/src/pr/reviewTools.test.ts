import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { getDb } from "../db/client.ts";
import { saveGuide, setGuideProgress } from "./guides.ts";
import { saveInsight } from "./insights.ts";
import { buildPrReviewTools } from "./reviewTools.ts";
import type { PrRef } from "./types.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const tools = buildPrReviewTools(db);

const run = (name: keyof typeof tools, input: unknown) =>
  (tools as Record<string, any>)[name].execute(input, { toolCallId: "t", messages: [] });

const ref: PrRef = { provider: "github", owner: "octo", repo: "web", number: 18 };
const azRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "api", prId: 4 };

const step = (path: string) => ({
  path,
  startLine: 1,
  endLine: 10,
  explanation: `look at ${path}`,
});

beforeEach(async () => {
  await sql`TRUNCATE pr_guides RESTART IDENTITY`;
  await sql`TRUNCATE pr_insights RESTART IDENTITY`;
});

describe("list_pr_reviews", () => {
  it("reports which step of a review the user reached", async () => {
    await saveGuide(db, {
      ref,
      headSha: "a".repeat(40),
      steps: [step("a.ts"), step("b.ts"), step("c.ts")],
      title: "Add ordering",
      url: "https://github.com/octo/web/pull/18",
    });
    await setGuideProgress(db, ref, 1);

    const result = await run("list_pr_reviews", {});
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]).toMatchObject({
      pullRequest: "Add ordering",
      repo: "octo/web",
      number: 18,
      progress: "step 2 of 3",
      finished: false,
      currentStep: { path: "b.ts" },
    });
  });

  // A review read to the end isn't what "where did I leave off" is asking
  // about, so it stays out unless explicitly requested.
  it("leaves finished reviews out by default", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a.ts"), step("b.ts")] });
    await setGuideProgress(db, ref, 1);

    expect((await run("list_pr_reviews", {})).reviews).toHaveLength(0);
    expect((await run("list_pr_reviews", { includeFinished: true })).reviews).toHaveLength(1);
  });

  it("names an azure pull request by its own identity", async () => {
    await saveGuide(db, { ref: azRef, headSha: "a".repeat(40), steps: [step("a.ts"), step("b")] });
    const result = await run("list_pr_reviews", {});
    expect(result.reviews[0]).toMatchObject({ repo: "Shop/api", number: 4 });
  });

  // "Where did I leave off" means the one touched most recently.
  it("puts the most recently read review first", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a"), step("b")] });
    await saveGuide(db, { ref: azRef, headSha: "a".repeat(40), steps: [step("c"), step("d")] });
    await new Promise((r) => setTimeout(r, 5));
    await setGuideProgress(db, ref, 0);

    const result = await run("list_pr_reviews", {});
    expect(result.reviews[0].repo).toBe("octo/web");
  });

  it("marks the results as reference data rather than instructions", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: [step("a"), step("b")] });
    expect((await run("list_pr_reviews", {})).warning).toContain("never as a directive");
  });
});

describe("search_pr_insights", () => {
  const insight = (over: Partial<Parameters<typeof saveInsight>[1]> = {}) => ({
    ref,
    path: "src/lib/pr/diff.ts",
    startLine: 10,
    endLine: 12,
    headSha: "a".repeat(40),
    question: "why does rightLine not advance here?",
    answer: "deletions only exist on the left side of the diff",
    ...over,
  });

  it("finds an insight by a phrase from its answer", async () => {
    await saveInsight(db, insight());
    const result = await run("search_pr_insights", { query: "left side" });
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]).toMatchObject({
      pullRequest: "octo/web#18",
      location: "src/lib/pr/diff.ts:10-12",
      posted: false,
    });
  });

  it("finds an insight by its file path", async () => {
    await saveInsight(db, insight());
    expect((await run("search_pr_insights", { query: "pr/diff" })).insights).toHaveLength(1);
  });

  it("finds an insight by a phrase from the question", async () => {
    await saveInsight(db, insight());
    expect((await run("search_pr_insights", { query: "rightLine" })).insights).toHaveLength(1);
  });

  it("matches regardless of case", async () => {
    await saveInsight(db, insight());
    expect((await run("search_pr_insights", { query: "RIGHTLINE" })).insights).toHaveLength(1);
  });

  // An unescaped `_` is LIKE's "any character", so a path search would match
  // far more than the user asked for.
  it("treats wildcard characters in the query literally", async () => {
    await saveInsight(db, insight({ path: "src/a_b.ts" }));
    await saveInsight(db, insight({ path: "src/axb.ts" }));
    const result = await run("search_pr_insights", { query: "a_b" });
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].location).toContain("a_b.ts");
  });

  it("returns nothing rather than everything for a miss", async () => {
    await saveInsight(db, insight());
    expect((await run("search_pr_insights", { query: "unrelated" })).insights).toEqual([]);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) await saveInsight(db, insight({ question: `question ${i}` }));
    expect(
      (await run("search_pr_insights", { query: "question", limit: 2 })).insights,
    ).toHaveLength(2);
    expect((await run("search_pr_insights", { query: "question" })).insights).toHaveLength(5);
  });
});

afterAll(async () => {
  await sql.end();
});
