import { publish as publishAttention } from "../attention/hub.ts";
import { clearAttentionScope, createAttention } from "../attention/service.ts";
import type { Db } from "../db/client.ts";
import type { HeadsDownQuestion } from "../db/schema.ts";
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

export interface MergeAnnouncement {
  /** "owner/repo". */
  repo: string;
  number: number;
  title?: string | null;
  url?: string | null;
  risk: MergeRisk;
  why: string;
}

/** Identifies a PR across announce_merge and the merge call itself. */
export function mergeKey(repo: string, number: number): string {
  return `${repo.trim().toLowerCase()}#${number}`;
}

/**
 * Tells the user a pass is merging a PR. The item carries the merge in its
 * payload, which is what makes the app pop it up over whatever page is open.
 */
export async function announceMerge(db: Db, merge: MergeAnnouncement): Promise<void> {
  const [owner, name] = merge.repo.split("/");
  const item = await createAttention(db, {
    source: "system",
    // One item per PR: announcing the same merge again updates it.
    sessionKey: `heads-down-merge:${mergeKey(merge.repo, merge.number)}`,
    kind: "info",
    title: `Heads down is merging ${merge.repo}#${merge.number}`,
    body: [merge.title, merge.why].filter(Boolean).join("\n"),
    navTarget:
      owner && name
        ? { type: "pr", owner, repo: name, number: merge.number }
        : { type: "heads-down" },
    payload: { headsDownMerge: merge },
  });
  publishAttention(item);
}
