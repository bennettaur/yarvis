import { publish as publishAttention } from "../attention/hub.ts";
import { clearAttentionScope, createAttention } from "../attention/service.ts";
import type { Db } from "../db/client.ts";
import type { HeadsDownQuestion } from "../db/schema.ts";
import { askQuestion, type QuestionInput } from "./service.ts";

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
