import { and, eq, ne, sql } from "drizzle-orm";
import { publish } from "../attention/hub.ts";
import { navTargetFor } from "../attention/navTarget.ts";
import { createAttention } from "../attention/service.ts";
import type { Db } from "../db/client.ts";
import {
  type AgentQuestionAnswer,
  type AgentQuestionContext,
  type AgentQuestionItem,
  type AgentQuestionRow,
  agentQuestions,
  attentionItems,
  workspaces,
} from "../db/schema.ts";

/**
 * Questions a coding agent asks the user through the MCP `ask_user` tool. Asking
 * stores the question set and raises a `question` attention item, so the bell
 * rings and the panel can open an answer dialog without leaving the current
 * page. Answering stores the reply, resolves the attention item once the
 * session has nothing else waiting, and wakes the tool call blocked on it.
 */

export interface AskInput {
  sessionKey: string | null;
  workspaceId: string | null;
  context: AgentQuestionContext;
  questions: AgentQuestionItem[];
}

/** Longest a question's text may run in the attention row before it is cut. */
const BODY_PREVIEW_CHARS = 140;

function preview(questions: AgentQuestionItem[]): string {
  const first = questions[0]?.question ?? "Has a question for you";
  const text = first.length > BODY_PREVIEW_CHARS ? `${first.slice(0, BODY_PREVIEW_CHARS)}…` : first;
  return questions.length > 1 ? `${text} (+${questions.length - 1} more)` : text;
}

/**
 * Stores a question set and raises its attention item. A workspace id that
 * names no workspace is dropped rather than failing the foreign key: it comes
 * from a request header, and a question with no workspace is still answerable.
 */
export async function askQuestions(db: Db, input: AskInput): Promise<AgentQuestionRow> {
  const [ws] = input.workspaceId
    ? await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
    : [];
  const workspaceId = ws?.id ?? null;

  const [row] = await db
    .insert(agentQuestions)
    .values({
      sessionKey: input.sessionKey,
      workspaceId,
      context: input.context,
      questions: input.questions,
    })
    .returning();

  const item = await createAttention(db, {
    source: "system",
    sessionKey: input.sessionKey,
    workspaceId,
    kind: "question",
    title: ws?.name ?? "Claude session",
    body: preview(input.questions),
    navTarget: input.sessionKey
      ? navTargetFor(input.sessionKey, workspaceId ?? undefined)
      : workspaceId
        ? { type: "workspace", workspaceId }
        : null,
    // A session's question items coalesce into one, so the dialog lists that
    // session's pending questions; a sessionless item is found by this id.
    payload: { questionId: row!.id },
  });
  publish(item);
  return row!;
}

export async function getQuestion(db: Db, id: string): Promise<AgentQuestionRow | undefined> {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, id));
  return row;
}

/** A session's pending questions, oldest first so the dialog asks them in order. */
export async function listPendingQuestions(
  db: Db,
  sessionKey: string,
): Promise<AgentQuestionRow[]> {
  return db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.sessionKey, sessionKey), eq(agentQuestions.status, "pending")))
    .orderBy(agentQuestions.createdAt);
}

export type Reply = { status: "answered"; answers: AgentQuestionAnswer[] } | { status: "declined" };

export type ReplyResult =
  | { ok: true; row: AgentQuestionRow }
  | { ok: false; reason: "not-found" | "not-pending" | "invalid"; message: string };

/**
 * Checks answers against the questions they reply to: one per question, picked
 * labels must be offered ones, a single-select question takes at most one, and
 * every question gets either a pick or some text.
 */
export function validateAnswers(
  questions: AgentQuestionItem[],
  answers: AgentQuestionAnswer[],
): string | null {
  if (answers.length !== questions.length) {
    return `expected ${questions.length} answers, got ${answers.length}`;
  }
  for (const [i, question] of questions.entries()) {
    const answer = answers[i]!;
    const labels = new Set((question.options ?? []).map((o) => o.label));
    const unknown = answer.selected.find((label) => !labels.has(label));
    if (unknown !== undefined) return `question ${i + 1}: "${unknown}" is not one of its options`;
    if (!question.multiSelect && answer.selected.length > 1) {
      return `question ${i + 1} takes a single choice`;
    }
    if (answer.selected.length === 0 && !answer.text?.trim()) {
      return `question ${i + 1} has no answer`;
    }
  }
  return null;
}

/**
 * Records the user's reply and wakes the waiting tool call. The update only
 * matches a pending row, so two surfaces answering at once can't both win.
 */
export async function replyToQuestion(db: Db, id: string, reply: Reply): Promise<ReplyResult> {
  const existing = await getQuestion(db, id);
  if (!existing) return { ok: false, reason: "not-found", message: "no such question" };
  if (existing.status !== "pending") {
    return { ok: false, reason: "not-pending", message: `question is already ${existing.status}` };
  }
  if (reply.status === "answered") {
    const problem = validateAnswers(existing.questions, reply.answers);
    if (problem) return { ok: false, reason: "invalid", message: problem };
  }

  const [row] = await db
    .update(agentQuestions)
    .set({
      status: reply.status,
      answers: reply.status === "answered" ? reply.answers : null,
      answeredAt: new Date(),
    })
    .where(and(eq(agentQuestions.id, id), eq(agentQuestions.status, "pending")))
    .returning();
  if (!row) return { ok: false, reason: "not-pending", message: "question was already answered" };

  await resolveAttentionFor(db, row);
  wake(id);
  return { ok: true, row };
}

/**
 * Resolves the question's attention item once nothing else from its session is
 * waiting. The item is shared by all of a session's questions, so answering the
 * first of two leaves it up for the second.
 */
async function resolveAttentionFor(db: Db, row: AgentQuestionRow): Promise<void> {
  if (row.sessionKey) {
    const [stillWaiting] = await db
      .select({ id: agentQuestions.id })
      .from(agentQuestions)
      .where(
        and(
          eq(agentQuestions.sessionKey, row.sessionKey),
          eq(agentQuestions.status, "pending"),
          ne(agentQuestions.id, row.id),
        ),
      )
      .limit(1);
    if (stillWaiting) return;
  }

  const now = new Date();
  const resolved = await db
    .update(attentionItems)
    .set({ status: "resolved", resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(attentionItems.kind, "question"),
        ne(attentionItems.status, "resolved"),
        row.sessionKey
          ? eq(attentionItems.sessionKey, row.sessionKey)
          : sql`${attentionItems.payload}->>'questionId' = ${row.id}`,
      ),
    )
    .returning();
  for (const item of resolved) publish(item);
}

/**
 * Tool calls blocked on an answer, by question id. Process-local like the
 * attention hub: the instance that served `ask_user` is the one holding the
 * call, and a reply that lands on another instance is still read from the
 * database when the wait ends.
 */
const waiters = new Map<string, Set<() => void>>();

function wake(id: string): void {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const resolve of set) resolve();
}

/**
 * Waits up to `timeoutMs` for a reply, then returns the row as it stands —
 * still pending if the user hasn't answered. Resolves early when `signal`
 * aborts, so a dropped connection doesn't hold the waiter.
 */
export async function waitForReply(
  db: Db,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AgentQuestionRow | undefined> {
  let done = () => {};
  // Registered before the first read, so a reply landing between the read and
  // the wait still wakes it.
  const replied = new Promise<void>((resolve) => {
    done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      const set = waiters.get(id);
      set?.delete(done);
      if (set?.size === 0) waiters.delete(id);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    signal?.addEventListener("abort", done, { once: true });
    let set = waiters.get(id);
    if (!set) {
      set = new Set();
      waiters.set(id, set);
    }
    set.add(done);
  });

  const current = await getQuestion(db, id);
  if (current?.status === "pending" && !signal?.aborted) await replied;
  else done();
  return current?.status === "pending" ? getQuestion(db, id) : current;
}
