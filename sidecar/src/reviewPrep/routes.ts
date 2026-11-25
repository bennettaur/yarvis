import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { type ReviewPrepState, type RiskLevel, reviewPreps } from "../db/schema.ts";
import { shortPrName } from "../reviewWorkspaces/kickoff.ts";
import { getReviewPrepConfig } from "./config.ts";
import { backlogPreps, SLOT_STATES } from "./service.ts";

/** What the review stream holds: the PRs holding a slot, and the backlog behind them. */
export interface ReviewStream {
  maxReady: number;
  slots: { pr: string; state: ReviewPrepState; risk: RiskLevel | null }[];
  /** Oldest first, which is the order they start in. */
  backlog: { pr: string; backloggedAt: string | null }[];
}

export function createReviewPrepRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/stream", async (c) => {
    const [{ maxReady }, slots, backlog] = await Promise.all([
      getReviewPrepConfig(),
      db().select().from(reviewPreps).where(inArray(reviewPreps.state, SLOT_STATES)),
      backlogPreps(db()),
    ]);
    const body: ReviewStream = {
      maxReady,
      slots: slots.map((row) => ({
        pr: shortPrName(row.ref),
        state: row.state,
        risk: row.risk,
      })),
      backlog: backlog.map((row) => ({
        pr: shortPrName(row.ref),
        backloggedAt: row.backloggedAt?.toISOString() ?? null,
      })),
    };
    return c.json(body);
  });

  return router;
}
