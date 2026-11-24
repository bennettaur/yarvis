import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { type ReviewPrepState, reviewPreps } from "../db/schema.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import { createReviewPrepRoutes, type ReviewStream } from "./routes.ts";
import { prepAttentionKey } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

const config = { databaseUrl: url } as Config;
const ref = (number: number): PrRef => ({ provider: "github", owner: "o", repo: "r", number });

async function prep(number: number, state: ReviewPrepState, extra: { minutesAgo?: number } = {}) {
  const key = refKey(ref(number));
  await db.insert(reviewPreps).values({
    refKey: key,
    ref: ref(number),
    state,
    risk: state === "ready" ? "high" : null,
    backloggedAt:
      state === "backlog" ? new Date(Date.now() - (extra.minutesAgo ?? 0) * 60_000) : null,
    attentionKey: prepAttentionKey(key),
  });
}

beforeEach(async () => {
  await sql`TRUNCATE review_preps RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("GET /stream", () => {
  it("lists what holds a slot and the backlog, oldest first, leaving the rest out", async () => {
    await prep(1, "ready");
    await prep(2, "needs-go-ahead");
    await prep(3, "failed");
    await prep(4, "released");
    await prep(5, "backlog", { minutesAgo: 1 });
    await prep(6, "backlog", { minutesAgo: 10 });

    const res = await createReviewPrepRoutes(config).request("/stream");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReviewStream;
    expect(body.maxReady).toBe(5);
    expect(body.slots.map((s) => [s.pr, s.state, s.risk]).sort()).toEqual([
      ["r#1", "ready", "high"],
      ["r#2", "needs-go-ahead", null],
    ]);
    expect(body.backlog.map((b) => b.pr)).toEqual(["r#6", "r#5"]);
  });
});
