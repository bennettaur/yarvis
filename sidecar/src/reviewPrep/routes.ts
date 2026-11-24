import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { reviewPreps } from "../db/schema.ts";
import type { PrRef } from "../pr/types.ts";
import { shortPrName } from "../reviewWorkspaces/kickoff.ts";
import { getReviewPrepConfig } from "./config.ts";
import { queuedPreps, SLOT_STATES } from "./service.ts";

/** What the review stream holds: the PRs holding a slot, and the queue behind them. */
export interface ReviewStream {
  maxReady: number;
  slots: { pr: string; ref: PrRef; state: string; risk: string | null }[];
  /** Oldest first, which is the order they start in. */
  queue: { pr: string; ref: PrRef; queuedAt: string | null }[];
}

export function createReviewPrepRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/stream", async (c) => {
    const [{ maxReady }, slots, queue] = await Promise.all([
      getReviewPrepConfig(),
      db().select().from(reviewPreps).where(inArray(reviewPreps.state, SLOT_STATES)),
      queuedPreps(db()),
    ]);
    const body: ReviewStream = {
      maxReady,
      slots: slots.map((row) => ({
        pr: shortPrName(row.ref),
        ref: row.ref,
        state: row.state,
        risk: row.risk,
      })),
      queue: queue.map((row) => ({
        pr: shortPrName(row.ref),
        ref: row.ref,
        queuedAt: row.queuedAt?.toISOString() ?? null,
      })),
    };
    return c.json(body);
  });

  return router;
}
