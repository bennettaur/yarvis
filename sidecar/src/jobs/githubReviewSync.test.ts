import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { listEvents, recordEvent } from "../events/service.ts";
import { type ReviewContribution, reviewExternalId } from "../github/client.ts";
import {
  githubReviewSyncJob,
  nextCursor,
  recordReviewContributions,
  syncWindow,
} from "./githubReviewSync.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

const window = {
  from: new Date("2026-10-01T00:00:00Z"),
  to: new Date("2026-10-02T00:00:00Z"),
};

function contribution(over: Partial<ReviewContribution> = {}): ReviewContribution {
  return {
    reviewId: "R_1",
    state: "approved",
    submittedAt: "2026-10-01T12:00:00Z",
    owner: "o",
    repo: "r",
    number: 7,
    ...over,
  };
}

/** An approval the app logged without a review id, as older builds did. */
function idLessApproval(at: string, ref = "gh:o/r/7") {
  return recordEvent(db, {
    type: "pr.approved",
    source: "github",
    payload: { ref, hasBody: false },
    occurredAt: new Date(at),
  });
}

describe("recording synced reviews", () => {
  it("logs approvals and change requests at their submit time, and nothing else", async () => {
    const added = await recordReviewContributions(
      db,
      [
        contribution(),
        contribution({ reviewId: "R_2", state: "changes_requested", number: 8 }),
        contribution({ reviewId: "R_3", state: "commented", number: 9 }),
      ],
      window,
    );
    expect(added).toBe(2);
    const rows = await listEvents(db, { oldestFirst: true });
    expect(rows.map((r) => [r.type, r.source, r.payload, r.externalId])).toEqual([
      ["pr.approved", "github-sync", { ref: "gh:o/r/7" }, reviewExternalId("R_1")],
      ["pr.changes_requested", "github-sync", { ref: "gh:o/r/8" }, reviewExternalId("R_2")],
    ]);
    expect(rows[0]!.occurredAt.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("skips a review the app already logged with its id", async () => {
    await recordEvent(db, {
      type: "pr.approved",
      source: "github",
      payload: { ref: "gh:o/r/7", hasBody: false },
      externalId: reviewExternalId("R_1"),
    });
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(0);
    expect((await listEvents(db)).length).toBe(1);
  });

  it("treats an in-app event with no id a few minutes from the review as that review", async () => {
    await idLessApproval("2026-10-01T12:02:00Z");
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(0);
    expect((await listEvents(db)).length).toBe(1);
  });

  it("matches an event logged just before the window starts", async () => {
    await idLessApproval("2026-09-30T23:58:00Z");
    const review = contribution({ submittedAt: "2026-10-01T00:01:00Z" });
    expect(await recordReviewContributions(db, [review], window)).toBe(0);
  });

  it("only matches the same verdict on the same PR", async () => {
    await idLessApproval("2026-10-01T12:00:00Z", "gh:o/r/8");
    await recordEvent(db, {
      type: "pr.changes_requested",
      source: "github",
      payload: { ref: "gh:o/r/7" },
      occurredAt: new Date("2026-10-01T12:00:00Z"),
    });
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(1);
  });

  it("lets one event stand for one review only", async () => {
    await idLessApproval("2026-10-01T12:00:00Z");
    const second = contribution({ reviewId: "R_2", submittedAt: "2026-10-01T12:01:00Z" });
    expect(await recordReviewContributions(db, [contribution(), second], window)).toBe(1);
  });

  it("doesn't let a different review's keyed event stand in for this one", async () => {
    await recordEvent(db, {
      type: "pr.approved",
      source: "github",
      payload: { ref: "gh:o/r/7" },
      occurredAt: new Date("2026-10-01T12:00:00Z"),
      externalId: reviewExternalId("R_0"),
    });
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(1);
  });

  it("still logs a second approval of the same PR given well after the first", async () => {
    await idLessApproval("2026-10-01T09:00:00Z");
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(1);
  });

  it("is safe to run over the same window twice", async () => {
    await recordReviewContributions(db, [contribution()], window);
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(0);
    expect((await listEvents(db)).length).toBe(1);
  });
});

describe("the sync window", () => {
  const now = new Date("2026-10-05T12:00:00Z");

  it("backfills two weeks without a cursor, or with one it can't read", () => {
    const backfill = { from: new Date("2026-09-21T12:00:00Z"), to: now };
    expect(syncWindow(null, now)).toEqual(backfill);
    expect(syncWindow({ nextFrom: "not a date" }, now)).toEqual(backfill);
  });

  it("starts where the cursor says", () => {
    expect(syncWindow({ nextFrom: "2026-10-04T11:30:00Z" }, now).from).toEqual(
      new Date("2026-10-04T11:30:00Z"),
    );
  });

  it("never reaches back further than GitHub allows", () => {
    expect(syncWindow({ nextFrom: "2024-01-01T00:00:00Z" }, now).from).toEqual(
      new Date("2025-10-06T12:00:00Z"),
    );
  });

  it("re-reads a day next time, for contributions GitHub lists late", () => {
    const read = { contributions: [contribution()], truncated: false };
    expect(nextCursor({ from: window.from, to: now }, read)).toEqual({
      nextFrom: "2026-10-04T12:00:00.000Z",
    });
  });

  it("carries on from the last review read when the page cap cut the read short", () => {
    const read = {
      contributions: [contribution({ submittedAt: "2026-10-01T08:00:00Z" })],
      truncated: true,
    };
    expect(nextCursor({ from: window.from, to: now }, read)).toEqual({
      nextFrom: "2026-10-01T08:00:00Z",
    });
  });
});

describe("the sync job", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answers the contributions query with the given nodes, recording the variables sent. */
  function stubGithub(nodes: unknown[]): Array<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).variables);
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              contributionsCollection: {
                restrictedContributionsCount: 0,
                pullRequestReviewContributions: { pageInfo: { hasNextPage: false }, nodes },
              },
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return sent;
  }

  const node = (id: string, state: string) => ({
    occurredAt: "2026-10-05T11:00:00Z",
    pullRequestReview: { id, state, submittedAt: "2026-10-05T11:00:00Z" },
    pullRequest: { number: 7, repository: { name: "r", owner: { login: "o" } } },
  });

  const now = new Date("2026-10-05T12:00:00Z");
  const run = (cursor: unknown) =>
    githubReviewSyncJob.run({
      db,
      config: { secrets: { githubToken: "t" } } as Config,
      cursor,
      now,
      trigger: "manual",
    });

  it("logs new verdicts and moves the cursor, then finds nothing on a second pass", async () => {
    const sent = stubGithub([node("R_1", "APPROVED"), node("R_2", "COMMENTED")]);
    const first = await run(null);
    expect(first.skipped).toBe(false);
    expect(first.cursor).toEqual({ nextFrom: "2026-10-04T12:00:00.000Z" });
    expect(sent[0]).toMatchObject({ from: "2026-09-21T12:00:00.000Z", to: now.toISOString() });
    expect((await listEvents(db)).map((e) => e.externalId)).toEqual([reviewExternalId("R_1")]);

    const second = await run(first.cursor);
    expect(sent[1]).toMatchObject({ from: "2026-10-04T12:00:00.000Z" });
    expect(second.skipped).toBe(true);
    expect(second.cursor).toEqual(first.cursor);
  });

  it("throws when GitHub errors, so the scheduler keeps the old cursor", async () => {
    globalThis.fetch = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    await expect(run({ nextFrom: "2026-10-04T00:00:00Z" })).rejects.toThrow("502");
  });

  it("skips without a GitHub token, leaving the cursor alone", async () => {
    const result = await githubReviewSyncJob.run({
      db,
      config: { secrets: {} } as Config,
      cursor: null,
      now,
      trigger: "manual",
    });
    expect(result.skipped).toBe(true);
    expect(result.cursor).toBeUndefined();
  });
});
