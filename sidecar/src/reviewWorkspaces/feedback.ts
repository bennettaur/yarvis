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
  type VerificationFeedbackItem,
  type VerificationFeedbackRow,
  verificationFeedback,
} from "../db/schema.ts";
import { clip } from "./agentContext.ts";
import { getReviewPr, ReviewWorkspaceError } from "./service.ts";
import { REPORT_SECTIONS, runSections, VERIFICATION_RUN_KIND } from "./verification.ts";

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
/** What the reviewer did with an item. Each is kept once, with when it was first done: doing it again says nothing new. */
export const FEEDBACK_ACTIONS = ["posted-pr", "added-workspace", "asked"] as const;
/** What a reviewer can rerate an item to: a finding's severity or a risk level, `none` included. */
export const FEEDBACK_RATINGS = ["none", "low", "medium", "high"] as const;

const MAX_REASON_CHARS = 2000;
/** Over this the body is refused; under it, the stored text is clipped. */
const MAX_INPUT_CHARS = 20_000;

const clipped = (max: number) =>
  z
    .string()
    .max(MAX_INPUT_CHARS)
    .transform((t) => clip(t, max));

const itemSchema = z.object({
  title: clipped(300),
  detail: clipped(1000),
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
    // Short enough for the unique index, which refuses entries past ~2.7 kB.
    itemKey: z.string().min(1).max(1000),
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

/**
 * A feedback row as it is read back. `item` is the report's text, which a
 * model wrote from the PR's code and the client sent back: fence it before it
 * goes into a prompt. Only `reason` is the reviewer's own words.
 */
export interface ReportFeedback {
  id: string;
  refKey: string;
  runId: string;
  section: string;
  kind: string;
  itemKey: string;
  item: VerificationFeedbackItem;
  verdict: VerificationFeedbackRow["verdict"];
  rating: string | null;
  reason: string | null;
  actions: VerificationFeedbackAction[];
  updatedAt: string;
}

function toFeedback(row: VerificationFeedbackRow): ReportFeedback {
  return {
    id: row.id,
    refKey: row.refKey,
    runId: row.runId,
    section: row.section,
    kind: row.kind,
    itemKey: row.itemKey,
    item: row.item,
    verdict: row.verdict,
    rating: row.rating,
    reason: row.reason,
    actions: row.actions.map((a) => a.action),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Checks the run is one of this PR's verification runs and wrote `section`,
 * so feedback can't be filed against a check that never ran, and returns the
 * head it ran on. Throws a 400 otherwise.
 */
async function verifiedRunHead(
  db: Db,
  refKey: string,
  runId: string,
  section: string,
): Promise<string | null> {
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
  if (!runSections(run.meta).includes(section as (typeof REPORT_SECTIONS)[number])) {
    throw new ReviewWorkspaceError(`that run didn't write the ${section} section`, 400);
  }
  return typeof run.meta.headSha === "string" ? run.meta.headSha : null;
}

/** Records feedback on one item, creating its row or updating the one already there. */
export async function saveFeedback(
  db: Db,
  workspaceId: string,
  prId: string,
  input: FeedbackInput,
  now: Date = new Date(),
): Promise<ReportFeedback> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const headSha = await verifiedRunHead(db, pr.refKey, input.runId, input.section);
  return db.transaction(async (tx) => {
    // Inserted first so there is always a row to lock: two first saves at
    // once (a post and a verdict, say) would otherwise both insert, and one fail.
    await tx
      .insert(verificationFeedback)
      .values({
        refKey: pr.refKey,
        runId: input.runId,
        headSha,
        section: input.section,
        kind: input.kind,
        itemKey: input.itemKey,
        item: input.item,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    // Locked so a verdict and an action saved at once don't drop each other's change.
    const [existing] = await tx
      .select()
      .from(verificationFeedback)
      .where(
        and(
          eq(verificationFeedback.refKey, pr.refKey),
          eq(verificationFeedback.runId, input.runId),
          eq(verificationFeedback.section, input.section),
          eq(verificationFeedback.itemKey, input.itemKey),
        ),
      )
      .for("update");
    // The rating and reason belong to the verdict, so clearing it clears them.
    const verdictFields =
      input.verdict === undefined
        ? {}
        : {
            verdict: input.verdict,
            rating: input.verdict === "rerated" ? (input.rating ?? null) : null,
            reason: input.verdict ? input.reason || null : null,
          };
    const nextActions =
      input.action && !existing.actions.some((a) => a.action === input.action)
        ? [...existing.actions, { action: input.action, at: now.toISOString() }]
        : existing.actions;
    const [row] = await tx
      .update(verificationFeedback)
      .set({ ...verdictFields, actions: nextActions, item: input.item, updatedAt: now })
      .where(eq(verificationFeedback.id, existing.id))
      .returning();
    return toFeedback(row);
  });
}

/** Every item's feedback on a PR's reports, newest first. */
export async function feedbackForPr(
  db: Db,
  workspaceId: string,
  prId: string,
): Promise<ReportFeedback[]> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const rows = await db
    .select()
    .from(verificationFeedback)
    .where(eq(verificationFeedback.refKey, pr.refKey))
    .orderBy(desc(verificationFeedback.updatedAt));
  return rows.map(toFeedback);
}

/** Most rows a reflection reads in one window, so its prompt stays a size a model can weigh. */
export const MAX_FEEDBACK_READ = 200;

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
  return { feedback: rows.slice(0, limit).map(toFeedback), truncated: rows.length > limit };
}
