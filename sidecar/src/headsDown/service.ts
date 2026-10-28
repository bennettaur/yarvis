import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  max,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  agentTools,
  CUT_SHORT_RESULT,
  chatMessages,
  type HeadsDownMessage,
  type HeadsDownPass,
  type HeadsDownQuestion,
  type HeadsDownRun,
  headsDownMessages,
  headsDownPasses,
  headsDownQuestions,
  headsDownRuns,
  type ToolActivity,
} from "../db/schema.ts";
import { type DecisionDetail, decisionContent, decisionQuery } from "../memory/decisions.ts";
import type { MemoryService } from "../memory/index.ts";

/**
 * Heads-down mode's state: whether it is running, what each pass did, what
 * the user told it, and what it asked them.
 */

/** Answered by the user, as opposed to approved by the decision model. */
const answeredByUser = sql`${headsDownQuestions.answeredBy} is distinct from 'decision-model'`;

export async function getActiveRun(db: Db): Promise<HeadsDownRun | null> {
  const [row] = await db.select().from(headsDownRuns).where(eq(headsDownRuns.status, "active"));
  return row ?? null;
}

export interface StartRunOptions {
  /** When the run stops on its own. Null clears it; left out keeps the one set. */
  stopAt?: Date | null;
}

/**
 * Turns heads-down mode on, or updates the run already going: its focus, when
 * one is given, and its stop time.
 */
export async function startRun(
  db: Db,
  focus: string | null,
  { stopAt }: StartRunOptions = {},
): Promise<HeadsDownRun> {
  const active = await getActiveRun(db);
  if (active) {
    if (focus === null && stopAt === undefined) return active;
    const [row] = await db
      .update(headsDownRuns)
      .set({
        ...(focus !== null ? { focus } : {}),
        ...(stopAt !== undefined ? { stopAt } : {}),
      })
      .where(eq(headsDownRuns.id, active.id))
      .returning();
    return row!;
  }
  try {
    const [row] = await db
      .insert(headsDownRuns)
      .values({ focus, stopAt: stopAt ?? null })
      .returning();
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

/** Pauses the active run, keeping when it was first paused. Null when nothing is running. */
export async function pauseRun(db: Db): Promise<HeadsDownRun | null> {
  const [row] = await db
    .update(headsDownRuns)
    .set({ pausedAt: sql`coalesce(${headsDownRuns.pausedAt}, now())` })
    .where(eq(headsDownRuns.status, "active"))
    .returning();
  return row ?? null;
}

/** Resumes the active run. Null when nothing is running or it wasn't paused. */
export async function resumeRun(db: Db): Promise<HeadsDownRun | null> {
  const [row] = await db
    .update(headsDownRuns)
    .set({ pausedAt: null })
    .where(and(eq(headsDownRuns.status, "active"), isNotNull(headsDownRuns.pausedAt)))
    .returning();
  return row ?? null;
}

/** Sets or clears when the active run stops. Null when nothing is running. */
export async function setStopAt(db: Db, stopAt: Date | null): Promise<HeadsDownRun | null> {
  const [row] = await db
    .update(headsDownRuns)
    .set({ stopAt })
    .where(eq(headsDownRuns.status, "active"))
    .returning();
  return row ?? null;
}

/**
 * How close to the stop time counts as reached. Timers can fire a little
 * early, and a cycle that just misses it would start a whole pass.
 */
const STOP_TIME_TOLERANCE_MS = 1000;

/** How long until the run's stop time, 0 once it has come, or Infinity when it has none. */
export function msUntilStop(run: HeadsDownRun | null, now = Date.now()): number {
  if (!run?.stopAt) return Infinity;
  const ms = run.stopAt.getTime() - now;
  return ms <= STOP_TIME_TOLERANCE_MS ? 0 : ms;
}

/** Whether a run may run passes now: still the active run, not paused, and before its stop time. */
export async function mayRunPasses(db: Db, runId: string): Promise<boolean> {
  const active = await getActiveRun(db);
  return active?.id === runId && active.pausedAt === null && msUntilStop(active) > 0;
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

/** Deletes every message, read or not. Returns how many there were. */
export async function deleteAllMessages(db: Db): Promise<number> {
  const deleted = await db.delete(headsDownMessages).returning({ id: headsDownMessages.id });
  return deleted.length;
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
  // The decision model's approvals are listed by listAutoApprovals, never as the user's answers.
  const conditions: SQL[] = [inArray(headsDownQuestions.status, [...statuses]), answeredByUser];
  if (since) conditions.push(gte(headsDownQuestions.createdAt, since));
  return db
    .select()
    .from(headsDownQuestions)
    .where(and(...conditions))
    .orderBy(desc(headsDownQuestions.createdAt))
    .limit(limit);
}

/** Answered by the user after `since`, oldest first: what the next pass has to act on. */
export async function answeredSince(db: Db, since: Date): Promise<HeadsDownQuestion[]> {
  return db
    .select()
    .from(headsDownQuestions)
    .where(
      and(
        eq(headsDownQuestions.status, "answered"),
        answeredByUser,
        gt(headsDownQuestions.answeredAt, since),
      ),
    )
    .orderBy(asc(headsDownQuestions.answeredAt));
}

export interface AutoApprovalInput {
  action: string;
  args: unknown;
  question: string;
  situation: string;
  /** The decision model's one-line reason. */
  reason: string;
}

/**
 * Records a call the decision model approved and the pass then made, so the
 * user can see what ran without them. Not a decision memory: only the user's
 * own answers are precedent.
 */
export async function recordAutoApproval(
  db: Db,
  input: AutoApprovalInput,
): Promise<HeadsDownQuestion> {
  const now = new Date();
  const [row] = await db
    .insert(headsDownQuestions)
    .values({
      kind: "approval",
      question: input.question,
      situation: input.situation,
      options: ["approve", "deny"],
      action: input.action,
      toolArgs: input.args ?? null,
      argsHash: hashArgs(input.args ?? null),
      status: "answered",
      choice: "approve",
      answer: input.reason,
      answeredBy: "decision-model",
      answeredAt: now,
      usedAt: now,
    })
    .returning();
  return row!;
}

/** Calls the decision model approved, newest first, for the page. */
export async function listAutoApprovals(db: Db, limit = 20): Promise<HeadsDownQuestion[]> {
  return db
    .select()
    .from(headsDownQuestions)
    .where(eq(headsDownQuestions.answeredBy, "decision-model"))
    .orderBy(desc(headsDownQuestions.answeredAt))
    .limit(limit);
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
      answeredBy: "user",
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
        gte(headsDownQuestions.answeredAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Approvals answered since `since` and not yet spent: every pass is reminded
 * of them, not only the one right after the answer.
 */
export async function unspentApprovals(db: Db, since: Date): Promise<HeadsDownQuestion[]> {
  return db
    .select()
    .from(headsDownQuestions)
    .where(
      and(
        eq(headsDownQuestions.kind, "approval"),
        eq(headsDownQuestions.status, "answered"),
        eq(headsDownQuestions.choice, "approve"),
        isNull(headsDownQuestions.usedAt),
        gte(headsDownQuestions.answeredAt, since),
      ),
    )
    .orderBy(asc(headsDownQuestions.answeredAt))
    .limit(20);
}

/** MCP tools the user allowed heads-down mode to call without asking. */
export async function listUnattendedTools(db: Db): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: agentTools.id, name: agentTools.name })
    .from(agentTools)
    .where(and(eq(agentTools.unattended, true), eq(agentTools.source, "mcp")))
    .orderBy(asc(agentTools.name));
}

export async function setToolUnattended(db: Db, id: string, unattended: boolean): Promise<boolean> {
  const rows = await db
    .update(agentTools)
    .set({ unattended, updatedAt: new Date() })
    .where(and(eq(agentTools.id, id), eq(agentTools.source, "mcp")))
    .returning({ id: agentTools.id });
  return rows.length > 0;
}

export async function isToolUnattended(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .select({ unattended: agentTools.unattended })
    .from(agentTools)
    .where(eq(agentTools.id, id));
  return row?.unattended ?? false;
}

/**
 * Records a pass as started. The routines it is given are recorded now rather
 * than when it finishes, so a sidecar that dies mid-pass still counts as having
 * tried them.
 */
export async function startPass(
  db: Db,
  runId: string,
  chatSessionId: string,
  routinesOffered: string[] = [],
): Promise<HeadsDownPass> {
  const [row] = await db
    .insert(headsDownPasses)
    .values({ runId, chatSessionId, routinesOffered })
    .returning();
  return row!;
}

export interface FinishPassInput {
  notes?: string | null;
  sleepMinutes: number;
  sleepReason: string;
  error?: string | null;
  /** Routines the pass reported done. */
  routinesDone?: string[];
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
      routinesDone: input.routinesDone ?? [],
    })
    .where(eq(headsDownPasses.id, id));
}

export interface RoutineHistory {
  /** When a pass last reported each routine done, by name. */
  lastDone: Map<string, Date>;
  /** When each routine was last given to a pass, by name. */
  lastOffered: Map<string, Date>;
}

/** The latest pass start each name appears in, for one of the routine name columns. */
async function latestPassByName(
  db: Db,
  column: typeof headsDownPasses.routinesDone | typeof headsDownPasses.routinesOffered,
): Promise<Map<string, Date>> {
  const name = sql<string>`r.name`;
  const rows = await db
    .select({ name, at: max(headsDownPasses.startedAt) })
    .from(headsDownPasses)
    .crossJoin(sql`jsonb_array_elements_text(${column}) as r(name)`)
    .where(sql`${column} <> '[]'::jsonb`)
    .groupBy(name);
  return new Map(rows.flatMap((r) => (r.at ? [[r.name, r.at] as const] : [])));
}

/**
 * When each routine was last given to a pass and last done, across every run:
 * a routine's cadence is about the user's day, not about when heads-down mode
 * was turned on.
 */
export async function routineHistory(db: Db): Promise<RoutineHistory> {
  const [lastDone, lastOffered] = await Promise.all([
    latestPassByName(db, headsDownPasses.routinesDone),
    latestPassByName(db, headsDownPasses.routinesOffered),
  ]);
  return { lastDone, lastOffered };
}

export async function listPasses(db: Db, limit = 20): Promise<HeadsDownPass[]> {
  return db.select().from(headsDownPasses).orderBy(desc(headsDownPasses.startedAt)).limit(limit);
}

/** Every tool call a pass made, in order, from the transcript in its hidden session. */
export async function passToolCalls(db: Db, chatSessionId: string): Promise<ToolActivity[]> {
  const rows = await db
    .select({ toolCalls: chatMessages.toolCalls })
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, chatSessionId), eq(chatMessages.role, "assistant")))
    .orderBy(asc(chatMessages.createdAt));
  return rows.flatMap((r) => r.toolCalls ?? []);
}

/** Longest a failed call's error is kept in a pass's summary. */
const FAILED_CALL_CHARS = 300;

export interface PassCallSummary {
  callCount: number;
  /** Calls that failed, or whose result never came back (`noResult`), so may have gone through. */
  failedCalls: { name: string; server: string | null; error: string | null; noResult: boolean }[];
}

/**
 * How many calls each pass made and which failed, keyed by its session id.
 * Counted in the database, since a pass's results run to megabytes and the
 * page only needs the tally and the errors.
 */
export async function passCallSummaries(
  db: Db,
  chatSessionIds: string[],
): Promise<Map<string, PassCallSummary>> {
  const summaries = new Map<string, PassCallSummary>();
  if (chatSessionIds.length === 0) return summaries;
  const calls = sql`coalesce(${chatMessages.toolCalls}, '[]'::jsonb)`;
  const rows = await db
    .select({
      sessionId: chatMessages.sessionId,
      callCount: sql<number>`jsonb_array_length(${calls})`,
      failed: sql<PassCallSummary["failedCalls"] | null>`(
        select jsonb_agg(jsonb_build_object(
          'name', c->>'name',
          'server', c->>'server',
          'error', left(c->>'result', ${FAILED_CALL_CHARS}),
          'noResult', c->>'status' = 'pending' or c->>'result' = ${CUT_SHORT_RESULT}
        ))
        from jsonb_array_elements(${calls}) as c
        where c->>'status' in ('error', 'pending')
      )`,
    })
    .from(chatMessages)
    .where(and(inArray(chatMessages.sessionId, chatSessionIds), eq(chatMessages.role, "assistant")))
    .orderBy(asc(chatMessages.createdAt));
  for (const row of rows) {
    const summary = summaries.get(row.sessionId) ?? { callCount: 0, failedCalls: [] };
    summary.callCount += row.callCount;
    summary.failedCalls.push(...(row.failed ?? []));
    summaries.set(row.sessionId, summary);
  }
  return summaries;
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
      .where(and(eq(headsDownQuestions.status, "answered"), answeredByUser))
      .orderBy(desc(headsDownQuestions.answeredAt))
      .limit(1),
  ]);
  const times = [run.startedAt, message?.at, answer?.at].filter((t): t is Date => t != null);
  return new Date(Math.max(...times.map((t) => t.getTime())));
}
