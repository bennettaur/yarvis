import { ensureOk, sidecarFetch } from "./api";
import type { AttentionItem } from "./attention";

/**
 * Client for the questions a coding agent asks through Yarvis's MCP `ask_user`
 * tool (`/api/questions`). The answer dialog reads what was asked and posts the
 * user's reply, which the sidecar hands back to the waiting agent.
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionAnswer {
  selected: string[];
  text?: string;
}

export interface AgentQuestion {
  id: string;
  sessionKey: string | null;
  workspaceId: string | null;
  context: { task: string; reason?: string };
  questions: QuestionItem[];
  status: "pending" | "answered" | "declined";
  createdAt: string;
}

/** A session's pending questions, oldest first. */
export async function listPendingQuestions(sessionKey: string): Promise<AgentQuestion[]> {
  const res = await sidecarFetch(`/api/questions?sessionKey=${encodeURIComponent(sessionKey)}`);
  await ensureOk(res, "list questions");
  return res.json();
}

export async function getQuestion(id: string): Promise<AgentQuestion> {
  const res = await sidecarFetch(`/api/questions/${encodeURIComponent(id)}`);
  await ensureOk(res, "load question");
  return res.json();
}

/**
 * The questions an attention item stands for. A session's question items
 * coalesce into one, so a session is asked for everything it has waiting; a
 * sessionless item names its one question in its payload.
 */
export async function questionsForItem(item: AttentionItem): Promise<AgentQuestion[]> {
  if (item.sessionKey) return listPendingQuestions(item.sessionKey);
  const payload = item.payload as { questionId?: unknown } | null | undefined;
  if (typeof payload?.questionId !== "string") return [];
  const question = await getQuestion(payload.questionId);
  return question.status === "pending" ? [question] : [];
}

export async function answerQuestion(id: string, answers: QuestionAnswer[]): Promise<void> {
  const res = await sidecarFetch(`/api/questions/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  await ensureOk(res, "answer question");
}

export async function declineQuestion(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/questions/${encodeURIComponent(id)}/decline`, {
    method: "POST",
  });
  await ensureOk(res, "decline question");
}
