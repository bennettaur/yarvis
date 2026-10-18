import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type HeadsDownMessage,
  type HeadsDownPass,
  type HeadsDownQuestion,
  type HeadsDownRun,
  headsDownMessages,
  headsDownPasses,
  headsDownQuestions,
  headsDownRuns,
} from "../db/schema.ts";
import { type DecisionDetail, decisionContent, decisionQuery } from "../memory/decisions.ts";
import type { MemoryService } from "../memory/index.ts";

/**
 * Heads-down mode's state: whether it is running, what each pass did, what
 * the user told it, and what it asked them.
 */

export async function getActiveRun(db: Db): Promise<HeadsDownRun | null> {
  const [row] = await db.select().from(headsDownRuns).where(eq(headsDownRuns.status, "active"));
  return row ?? null;
}

/** Turns heads-down mode on, or updates the focus of the run already going. */
export async function startRun(db: Db, focus: string | null): Promise<HeadsDownRun> {
  const active = await getActiveRun(db);
  if (active) {
    if (focus === null) return active;
    const [row] = await db
      .update(headsDownRuns)
      .set({ focus })
      .where(eq(headsDownRuns.id, active.id))
      .returning();
    return row!;
  }
  try {
    const [row] = await db.insert(headsDownRuns).values({ focus }).returning();
    return row!;
  } catch (e) {
    // Two starts at once: the one-active-run index turned the second away, so
    // return the run the first one made.
    const raced = await getActiveRun(db);
    if (raced) return raced;
    throw e;
  }
}

export async function stopRun(db: Db): Promise<HeadsDownRun | null> {
  const [row] = await db
    .update(headsDownRuns)
    .set({ status: "stopped", stoppedAt: new Date() })
    .where(eq(headsDownRuns.status, "active"))
    .returning();
  return row ?? null;
}

export async function addMessage(db: Db, body: string): Promise<HeadsDownMessage> {
  const [row] = await db.insert(headsDownMessages).values({ body: body.trim() }).returning();
  return row!;
}

export async function listMessages(db: Db, limit = 50): Promise<HeadsDownMessage[]> {
  return db
    .select()
    .from(headsDownMessages)
    .orderBy(desc(headsDownMessages.createdAt))
    .limit(limit);
}

/** The oldest messages a pass hasn't read, so a backlog reaches it in order rather than all at once. */
export async function unseenMessages(db: Db, limit = 20): Promise<HeadsDownMessage[]> {
  return db
    .select()
    .from(headsDownMessages)
    .where(isNull(headsDownMessages.seenAt))
    .orderBy(asc(headsDownMessages.createdAt))
    .limit(limit);
}

/**
 * Messages a pass has already read in this run, newest first. Standing
 * instructions ("watch #billing-intake") have to reach every pass, not only
 * the first one after they were sent.
 */
export async function earlierMessages(
  db: Db,
  since: Date,
  limit = 20,
): Promise<HeadsDownMessage[]> {
  return db
    .select()
    .from(headsDownMessages)
    .where(and(isNotNull(headsDownMessages.seenAt), gte(headsDownMessages.createdAt, since)))
    .orderBy(desc(headsDownMessages.createdAt))
    .limit(limit);
}

export async function markMessagesSeen(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(headsDownMessages)
    .set({ seenAt: new Date() })
    .where(inArray(headsDownMessages.id, ids));
}

/** A stable hash of a tool call's arguments, so an approved call can be matched when it is retried. */
export function hashArgs(args: unknown): string {
  return createHash("sha256").update(stableJson(args)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface QuestionInput {
  kind: HeadsDownQuestion["kind"];
  question: string;
  streamId?: string | null;
  situation?: string | null;
  options?: string[];
  action?: string | null;
  toolArgs?: unknown;
}

/**
 * Asks the user something, or returns the same question when it is already
 * open, so a pass that asks again doesn't stack duplicates. An approval is the
 * same question when it is for the same call.
 */
export async function askQuestion(db: Db, input: QuestionInput): Promise<HeadsDownQuestion> {
  const argsHash = input.kind === "approval" ? hashArgs(input.toolArgs ?? null) : null;
  const sameQuestion: SQL[] = [
    eq(headsDownQuestions.status, "open"),
    eq(headsDownQuestions.kind, input.kind),
  ];
  if (argsHash && input.action) {
    sameQuestion.push(eq(headsDownQuestions.action, input.action));
    sameQuestion.push(eq(headsDownQuestions.argsHash, argsHash));
  } else {
    sameQuestion.push(eq(headsDownQuestions.question, input.question));
  }
  const [existing] = await db
    .select()
    .from(headsDownQuestions)
    .where(and(...sameQuestion));
  if (existing) return existing;

  const [row] = await db
    .insert(headsDownQuestions)
    .values({
      kind: input.kind,
      question: input.question,
      streamId: input.streamId ?? null,
      situation: input.situation ?? null,
      options: input.options ?? [],
      action: input.action ?? null,
      toolArgs: input.kind === "approval" ? (input.toolArgs ?? null) : null,
      argsHash,
    })
    .returning();
  return row!;
}

export async function getQuestion(db: Db, id: string): Promise<HeadsDownQuestion | null> {
  const [row] = await db.select().from(headsDownQuestions).where(eq(headsDownQuestions.id, id));
  return row ?? null;
}

export interface ListQuestionsOptions {
  statuses?: readonly HeadsDownQuestion["status"][];
  /** Only questions asked at or after this, e.g. in the current run. */
  since?: Date;
  limit?: number;
}

/** Newest first. Defaults to the open questions. */
export async function listQuestions(
  db: Db,
  { statuses = ["open"], since, limit = 100 }: ListQuestionsOptions = {},
): Promise<HeadsDownQuestion[]> {
  const conditions: SQL[] = [inArray(headsDownQuestions.status, [...statuses])];
  if (since) conditions.push(gte(headsDownQuestions.createdAt, since));
  return db
    .select()
    .from(headsDownQuestions)
    .where(and(...conditions))
    .orderBy(desc(headsDownQuestions.createdAt))
    .limit(limit);
}

/** Answered after `since`, oldest first: what the next pass has to act on. */
export async function answeredSince(db: Db, since: Date): Promise<HeadsDownQuestion[]> {
  return db
    .select()
    .from(headsDownQuestions)
    .where(and(eq(headsDownQuestions.status, "answered"), gt(headsDownQuestions.answeredAt, since)))
    .orderBy(asc(headsDownQuestions.answeredAt));
}

/** A choice label is one short line, as decision memory compares them. */
function choiceLabel(text: string): string {
  return text
    .replace(/[\n<>]+/g, " ")
    .trim()
    .slice(0, 80);
}

export interface AnswerInput {
  /** One of the question's options, or "approve"/"deny" for an approval. */
  choice?: string;
  /** The answer in the user's own words. */
  answer?: string;
}

/**
 * Records the user's answer and stores it as a decision memory, so the same
 * question can be settled from it next time. Recorded here rather than by the
 * model because this is the one place that knows the answer is the user's own.
 */
export async function answerQuestion(
  db: Db,
  memory: MemoryService,
  id: string,
  input: AnswerInput,
): Promise<HeadsDownQuestion | { error: string }> {
  const question = await getQuestion(db, id);
  if (!question || question.status !== "open") return { error: "no open question with that id" };
  const text = input.choice ?? input.answer;
  if (!text?.trim()) return { error: "give a choice or an answer" };
  if (question.kind === "approval" && input.choice !== "approve" && input.choice !== "deny") {
    return { error: "an approval is answered with approve or deny" };
  }

  const [row] = await db
    .update(headsDownQuestions)
    .set({
      status: "answered",
      choice: choiceLabel(text),
      answer: input.answer?.trim() || null,
      answeredAt: new Date(),
    })
    .where(and(eq(headsDownQuestions.id, id), eq(headsDownQuestions.status, "open")))
    .returning();
  if (!row) return { error: "no open question with that id" };

  const detail: DecisionDetail = {
    situation: row.situation ?? "",
    question: row.question,
    choice: row.choice!,
    answer: row.answer,
    action: row.action,
  };
  await memory.add(decisionContent(detail), {
    kind: "decision",
    sourceRef: { type: "heads-down-question", questionId: row.id },
    metadata: { decision: detail },
    searchText: decisionQuery(detail.situation, detail.question),
  });
  return row;
}

export async function dismissQuestion(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(headsDownQuestions)
    .set({ status: "dismissed" })
    .where(and(eq(headsDownQuestions.id, id), eq(headsDownQuestions.status, "open")))
    .returning({ id: headsDownQuestions.id });
  return rows.length > 0;
}

/**
 * Spends the user's approval for this exact call, if they gave one since
 * `since` that hasn't been used. Returns whether the call may run.
 */
export async function spendApproval(
  db: Db,
  action: string,
  args: unknown,
  since: Date,
): Promise<boolean> {
  const [grant] = await db
    .select({ id: headsDownQuestions.id })
    .from(headsDownQuestions)
    .where(
      and(
        eq(headsDownQuestions.kind, "approval"),
        eq(headsDownQuestions.status, "answered"),
        eq(headsDownQuestions.choice, "approve"),
        eq(headsDownQuestions.action, action),
        eq(headsDownQuestions.argsHash, hashArgs(args)),
        isNull(headsDownQuestions.usedAt),
        gte(headsDownQuestions.answeredAt, since),
      ),
    )
    .limit(1);
  if (!grant) return false;
  const spent = await db
    .update(headsDownQuestions)
    .set({ usedAt: new Date() })
    .where(and(eq(headsDownQuestions.id, grant.id), isNull(headsDownQuestions.usedAt)))
    .returning({ id: headsDownQuestions.id });
  return spent.length > 0;
}

/** Whether the user denied this exact call since `since`, so asking again would be noise. */
export async function deniedApprovalExists(
  db: Db,
  action: string,
  args: unknown,
  since: Date,
): Promise<boolean> {
  const rows = await db
    .select({ id: headsDownQuestions.id })
    .from(headsDownQuestions)
    .where(
      and(
        eq(headsDownQuestions.kind, "approval"),
        eq(headsDownQuestions.status, "answered"),
        eq(headsDownQuestions.choice, "deny"),
        eq(headsDownQuestions.action, action),
        eq(headsDownQuestions.argsHash, hashArgs(args)),
        gte(headsDownQuestions.createdAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function startPass(
  db: Db,
  runId: string,
  chatSessionId: string,
): Promise<HeadsDownPass> {
  const [row] = await db.insert(headsDownPasses).values({ runId, chatSessionId }).returning();
  return row!;
}

export interface FinishPassInput {
  notes?: string | null;
  sleepMinutes: number;
  sleepReason: string;
  error?: string | null;
}

export async function finishPass(db: Db, id: string, input: FinishPassInput): Promise<void> {
  await db
    .update(headsDownPasses)
    .set({
      finishedAt: new Date(),
      notes: input.notes ?? null,
      sleepMinutes: input.sleepMinutes,
      sleepReason: input.sleepReason,
      error: input.error ?? null,
    })
    .where(eq(headsDownPasses.id, id));
}

export async function listPasses(db: Db, limit = 20): Promise<HeadsDownPass[]> {
  return db.select().from(headsDownPasses).orderBy(desc(headsDownPasses.startedAt)).limit(limit);
}

export async function getPass(db: Db, id: string): Promise<HeadsDownPass | null> {
  const [row] = await db.select().from(headsDownPasses).where(eq(headsDownPasses.id, id));
  return row ?? null;
}

/** The last finished pass of a run: where the next one picks up. */
export async function lastFinishedPass(db: Db, runId: string): Promise<HeadsDownPass | null> {
  const [row] = await db
    .select()
    .from(headsDownPasses)
    .where(and(eq(headsDownPasses.runId, runId), isNotNull(headsDownPasses.finishedAt)))
    .orderBy(desc(headsDownPasses.startedAt))
    .limit(1);
  return row ?? null;
}

/** When the user last did something here: started the run, sent a message, or answered. */
export async function lastUserActivityAt(db: Db, run: HeadsDownRun): Promise<Date> {
  const [[message], [answer]] = await Promise.all([
    db
      .select({ at: headsDownMessages.createdAt })
      .from(headsDownMessages)
      .orderBy(desc(headsDownMessages.createdAt))
      .limit(1),
    db
      .select({ at: headsDownQuestions.answeredAt })
      .from(headsDownQuestions)
      .where(eq(headsDownQuestions.status, "answered"))
      .orderBy(desc(headsDownQuestions.answeredAt))
      .limit(1),
  ]);
  const times = [run.startedAt, message?.at, answer?.at].filter((t): t is Date => t != null);
  return new Date(Math.max(...times.map((t) => t.getTime())));
}
