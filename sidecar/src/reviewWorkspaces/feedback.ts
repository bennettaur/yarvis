/**
 * The reviewer's feedback on a verification report, item by item: whether an
 * item was right, why it wasn't, and what they did with it (posted it, added
 * it to the workspace, asked about it). The weekly review reflection reads it
 * back to see which checks help and which are noise, so the reason is the
 * reviewer's own words and the item is stored as the report showed it.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  agentRuns,
  type VerificationFeedbackAction,
  type VerificationFeedbackRow,
  verificationFeedback,
} from "../db/schema.ts";
import { clip } from "./agentContext.ts";
import { getReviewPr, ReviewWorkspaceError } from "./service.ts";
import { REPORT_SECTIONS, VERIFICATION_RUN_KIND } from "./verification.ts";

/** The parts of a report a reviewer can give feedback on. */
export const FEEDBACK_KINDS = [
  "summary",
  "mustRead",
  "mustReadFlag",
  "theme",
  "claim",
  "gap",
  "change",
  "concern",
  "finding",
  "approach",
] as const;

export const FEEDBACK_VERDICTS = ["accepted", "rejected", "rerated"] as const;
export const FEEDBACK_ACTIONS = ["posted-pr", "added-workspace", "asked"] as const;
/** What a reviewer can rerate an item to: a finding's severity or a risk level, `none` included. */
export const FEEDBACK_RATINGS = ["none", "low", "medium", "high"] as const;

const MAX_REASON_CHARS = 2000;

const itemSchema = z.object({
  title: z.string().transform((t) => clip(t, 300)),
  detail: z.string().transform((t) => clip(t, 1000)),
  rating: z.string().max(40).optional(),
  path: z.string().max(1000).optional(),
  line: z.number().int().positive().optional(),
});

/**
 * One change to an item's feedback. `verdict` present (null clears it) sets
 * the verdict, rating and reason together; `action` adds what the reviewer
 * did, once. Either or both.
 */
export const feedbackInputSchema = z
  .object({
    runId: z.string().uuid(),
    section: z.enum(REPORT_SECTIONS),
    kind: z.enum(FEEDBACK_KINDS),
    itemKey: z.string().min(1).max(2000),
    item: itemSchema,
    verdict: z.enum(FEEDBACK_VERDICTS).nullable().optional(),
    rating: z.enum(FEEDBACK_RATINGS).optional(),
    reason: z.string().trim().max(MAX_REASON_CHARS).optional(),
    action: z.enum(FEEDBACK_ACTIONS).optional(),
  })
  .refine((f) => f.verdict !== undefined || f.action !== undefined, {
    message: "give a verdict or an action",
  })
  .refine((f) => f.verdict !== "rerated" || f.rating !== undefined, {
    message: "a rerated item needs its new rating",
  });

export type FeedbackInput = z.output<typeof feedbackInputSchema>;

/** A feedback row as the report tab reads it. */
export interface FeedbackResponse {
  id: string;
  runId: string | null;
  section: string;
  kind: string;
  itemKey: string;
  verdict: VerificationFeedbackRow["verdict"];
  rating: string | null;
  reason: string | null;
  actions: VerificationFeedbackAction[];
  updatedAt: string;
}

function toResponse(row: VerificationFeedbackRow): FeedbackResponse {
  return {
    id: row.id,
    runId: row.runId,
    section: row.section,
    kind: row.kind,
    itemKey: row.itemKey,
    verdict: row.verdict,
    rating: row.rating,
    reason: row.reason,
    actions: row.actions.map((a) => a.action),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The run's head, or a 400 when the run isn't one of this PR's verification runs. */
async function runHead(db: Db, refKey: string, runId: string): Promise<string | null> {
  const [run] = await db
    .select({ meta: agentRuns.meta })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.kind, VERIFICATION_RUN_KIND),
        sql`${agentRuns.meta}->>'refKey' = ${refKey}`,
      ),
    );
  if (!run) throw new ReviewWorkspaceError("not a verification run of this pull request", 400);
  return typeof run.meta.headSha === "string" ? run.meta.headSha : null;
}

/** Records feedback on one item, creating its row or updating the one already there. */
export async function saveFeedback(
  db: Db,
  workspaceId: string,
  prId: string,
  input: FeedbackInput,
  now: Date = new Date(),
): Promise<FeedbackResponse> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const headSha = await runHead(db, pr.refKey, input.runId);
  const where = and(
    eq(verificationFeedback.refKey, pr.refKey),
    eq(verificationFeedback.runId, input.runId),
    eq(verificationFeedback.section, input.section),
    eq(verificationFeedback.itemKey, input.itemKey),
  );
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(verificationFeedback).where(where).for("update");
    const verdictFields =
      input.verdict === undefined
        ? {}
        : {
            verdict: input.verdict,
            rating: input.verdict === "rerated" ? (input.rating ?? null) : null,
            reason: input.verdict ? input.reason || null : null,
          };
    const actions = existing?.actions ?? [];
    const withAction =
      input.action && !actions.some((a) => a.action === input.action)
        ? [...actions, { action: input.action, at: now.toISOString() }]
        : actions;
    if (existing) {
      const [row] = await tx
        .update(verificationFeedback)
        .set({ ...verdictFields, actions: withAction, item: input.item, updatedAt: now })
        .where(eq(verificationFeedback.id, existing.id))
        .returning();
      return toResponse(row);
    }
    const [row] = await tx
      .insert(verificationFeedback)
      .values({
        refKey: pr.refKey,
        runId: input.runId,
        headSha,
        section: input.section,
        kind: input.kind,
        itemKey: input.itemKey,
        item: input.item,
        ...verdictFields,
        actions: withAction,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toResponse(row);
  });
}

/** Every item's feedback on a PR's reports, newest first. */
export async function feedbackForPr(
  db: Db,
  workspaceId: string,
  prId: string,
): Promise<FeedbackResponse[]> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const rows = await db
    .select()
    .from(verificationFeedback)
    .where(eq(verificationFeedback.refKey, pr.refKey))
    .orderBy(desc(verificationFeedback.updatedAt));
  return rows.map(toResponse);
}

/** Most rows a reflection reads in one window. */
export const MAX_FEEDBACK_READ = 200;

/** Feedback as a reflection reads it: what the item said, what the reviewer made of it, and why. */
export interface ReportFeedback {
  refKey: string;
  section: string;
  kind: string;
  item: VerificationFeedbackRow["item"];
  verdict: VerificationFeedbackRow["verdict"];
  rating: string | null;
  reason: string | null;
  actions: VerificationFeedbackAction[];
  updatedAt: string;
}

/**
 * The feedback given since `since`, newest first, on every PR. A row whose
 * verdict was cleared and that records no action says nothing, so it is left out.
 */
export async function feedbackSince(
  db: Db,
  since: Date,
  limit = MAX_FEEDBACK_READ,
): Promise<{ feedback: ReportFeedback[]; truncated: boolean }> {
  const rows = await db
    .select()
    .from(verificationFeedback)
    .where(
      and(
        gte(verificationFeedback.updatedAt, since),
        sql`(${verificationFeedback.verdict} is not null or jsonb_array_length(${verificationFeedback.actions}) > 0)`,
      ),
    )
    .orderBy(desc(verificationFeedback.updatedAt))
    .limit(limit + 1);
  return {
    feedback: rows.slice(0, limit).map((row) => ({
      refKey: row.refKey,
      section: row.section,
      kind: row.kind,
      item: row.item,
      verdict: row.verdict,
      rating: row.rating,
      reason: row.reason,
      actions: row.actions.map((a) => a.action),
      updatedAt: row.updatedAt.toISOString(),
    })),
    truncated: rows.length > limit,
  };
}
