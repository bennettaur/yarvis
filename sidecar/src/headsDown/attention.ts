import { and, eq, like } from "drizzle-orm";
import { publish as publishAttention } from "../attention/hub.ts";
import { clearAttentionScope, createAttention } from "../attention/service.ts";
import type { Db } from "../db/client.ts";
import { type AttentionNavTarget, attentionItems, type HeadsDownQuestion } from "../db/schema.ts";
import { askQuestion, dismissQuestion, listQuestions, type QuestionInput } from "./service.ts";

/**
 * A heads-down question also shows in the attention bell, since the user may
 * not have the Heads down page open. One attention item per question, settled
 * when the question is answered or dismissed.
 */

function sessionKeyFor(questionId: string): string {
  return `heads-down:${questionId}`;
}

/** Asks the user, and makes sure the question is in the bell. */
export async function askUser(db: Db, input: QuestionInput): Promise<HeadsDownQuestion> {
  const question = await askQuestion(db, input);
  // Raised again for a question already open: the bell keeps one pending item per question.
  const item = await createAttention(db, {
    source: "system",
    sessionKey: sessionKeyFor(question.id),
    kind: question.kind === "approval" ? "permission" : "info",
    title:
      question.kind === "approval" ? "Heads down needs your approval" : "Heads down has a question",
    body: question.question,
    navTarget: { type: "heads-down" },
  });
  publishAttention(item);
  return question;
}

/** Clears a question's bell item once it has been answered or dismissed. */
export async function settleQuestionAttention(db: Db, questionId: string): Promise<void> {
  const rows = await clearAttentionScope(db, { sessionKey: sessionKeyFor(questionId) }, "resolved");
  for (const row of rows) publishAttention(row);
}

/**
 * Dismisses every open question when heads-down mode stops. Their answers
 * would reach no pass, and an approval only holds within its run, so leaving
 * them in the bell would ask the user for nothing.
 */
export async function dismissOpenQuestions(db: Db): Promise<void> {
  for (const question of await listQuestions(db, { limit: 500 })) {
    if (await dismissQuestion(db, question.id)) await settleQuestionAttention(db, question.id);
  }
}

/** How risky a merge is, as the pass judged it; "unknown" when it merged without saying. */
export type MergeRisk = "low" | "medium" | "high" | "unknown";

/** A pass's own judgment outranks "unknown", and a higher risk outranks a lower one. */
const RISK_RANK: Record<MergeRisk, number> = { unknown: 0, low: 1, medium: 2, high: 3 };

export interface MergeAnnouncement {
  /** "owner/repo", or empty when the merge call didn't name one. */
  repo: string;
  /** Null for a merge a workspace's session was told to make, where the PR isn't known. */
  number: number | null;
  /** The workspace whose session was told to merge, for those. */
  workspaceId?: string | null;
  /** The PR's own title, as the pass read it. */
  title?: string | null;
  risk: MergeRisk;
  why: string;
}

/** Identifies a PR across announce_merge and the merge call itself. */
export function mergeKey(repo: string, number: number): string {
  return `${repo.trim().toLowerCase()}#${number}`;
}

function keyOf(merge: MergeAnnouncement): string {
  if (merge.number === null) return `workspace:${merge.workspaceId ?? ""}`;
  return mergeKey(merge.repo, merge.number);
}

const MERGE_KEY_PREFIX = "heads-down-merge:";

/**
 * Whether this pass already announced the merge. A merge call that doesn't
 * name its repo matches any announced PR with the same number.
 */
export function wasAnnounced(
  announced: ReadonlySet<string>,
  repo: string,
  number: number,
): boolean {
  if (repo) return announced.has(mergeKey(repo, number));
  return [...announced].some((key) => key.endsWith(`#${number}`));
}

/** The merge alert still waiting for the user about this PR, if any. */
async function pendingMergeAlert(
  db: Db,
  repo: string,
  number: number,
): Promise<MergeAnnouncement | null> {
  const sessionKey = repo
    ? eq(attentionItems.sessionKey, `${MERGE_KEY_PREFIX}${mergeKey(repo, number)}`)
    : like(attentionItems.sessionKey, `${MERGE_KEY_PREFIX}%#${number}`);
  const [row] = await db
    .select({ payload: attentionItems.payload })
    .from(attentionItems)
    .where(and(sessionKey, eq(attentionItems.kind, "info"), eq(attentionItems.status, "pending")))
    .limit(1);
  return (row?.payload as { headsDownMerge?: MergeAnnouncement } | null)?.headsDownMerge ?? null;
}

/** Whether the user already has an alert up for this PR, from this pass or an earlier one. */
export async function hasPendingMergeAlert(db: Db, repo: string, number: number): Promise<boolean> {
  return (await pendingMergeAlert(db, repo, number)) !== null;
}

/**
 * Tells the user a pass is merging a PR. The item carries the merge in its
 * payload, which is what makes the app pop it up over whatever page is open.
 * Announcing a PR again updates its alert, but never lowers the risk shown.
 */
export async function announceMerge(db: Db, merge: MergeAnnouncement): Promise<void> {
  let shown = merge;
  if (merge.number !== null) {
    const earlier = await pendingMergeAlert(db, merge.repo, merge.number);
    if (earlier && RISK_RANK[earlier.risk] > RISK_RANK[merge.risk]) {
      shown = { ...merge, risk: earlier.risk, why: earlier.why };
    }
  }
  const [owner, name] = shown.repo.split("/");
  const navTarget: AttentionNavTarget =
    shown.number !== null && owner && name
      ? { type: "pr", owner, repo: name, number: shown.number }
      : shown.workspaceId
        ? { type: "workspace", workspaceId: shown.workspaceId }
        : { type: "heads-down" };
  const item = await createAttention(db, {
    source: "system",
    // One item per PR: announcing the same merge again updates it.
    sessionKey: `${MERGE_KEY_PREFIX}${keyOf(shown)}`,
    kind: "info",
    title:
      shown.number === null
        ? "Heads down told a workspace to merge a PR"
        : `Heads down is merging ${shown.repo}#${shown.number}`,
    body: [shown.title, shown.why].filter(Boolean).join("\n"),
    navTarget,
    payload: { headsDownMerge: shown },
  });
  publishAttention(item);
}
