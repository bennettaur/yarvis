import { randomUUID } from "node:crypto";

/**
 * Permission requests from Claude Code sessions that the user can answer from
 * the app. A session's `PermissionRequest` hook posts the request to the ingest
 * route and holds the connection open; the route parks it here and waits. When
 * the user decides in the app, the waiting route answers the hook with that
 * decision and Claude Code acts on it.
 *
 * This lives in memory on purpose. A request is only answerable while its hook
 * is still connected to *this* sidecar, so a row in Postgres would outlive the
 * one thing that can act on it. The attention item the route also raises is the
 * durable record.
 */

/**
 * What the user chose. `terminal` hands the prompt back to Claude Code's own
 * dialog. `updatedInput` replaces the tool's input when Claude Code runs it.
 */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string }
  | { behavior: "terminal" };

/** Context about a request, everything except the waiting hook itself. */
export interface PermissionRequestInfo {
  id: string;
  sessionKey: string;
  workspaceId: string | null;
  workspaceName: string | null;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Claude Code's working directory for the session. */
  cwd: string | null;
  permissionMode: string | null;
  /** The agent's last text reply before asking, which usually says what it is trying to do. */
  lastReply: string | null;
  /** The last prompt the user typed in the session. */
  lastPrompt: string | null;
  createdAt: string;
}

interface PendingRequest {
  info: PermissionRequestInfo;
  resolve: (decision: PermissionDecision | null) => void;
}

const pending = new Map<string, PendingRequest>();

/**
 * Most requests held at once. Each holds a socket for minutes, and any process
 * in a Yarvis terminal holds the token that opens one. Past this, a new request
 * goes straight to Claude Code's own dialog.
 */
const MAX_PENDING = 64;

/** Whether another request can be held, or should be left to Claude Code's dialog. */
export function canHoldAnotherPermission(): boolean {
  return pending.size < MAX_PENDING;
}

export type NewPermissionRequest = Omit<PermissionRequestInfo, "id" | "createdAt">;

/**
 * Parks a request until the user decides, `timeoutMs` passes or `signal`
 * aborts (the hook went away). Resolves to the decision, or null when there
 * was none, which tells the hook to leave the prompt to Claude Code.
 *
 * `onRegistered` runs once the request is answerable, so the caller can
 * announce it without racing a decision that arrives first.
 */
export function awaitPermissionDecision(
  request: NewPermissionRequest,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    onRegistered?: (info: PermissionRequestInfo) => void;
  },
): Promise<PermissionDecision | null> {
  const id = randomUUID();
  const info: PermissionRequestInfo = { ...request, id, createdAt: new Date().toISOString() };

  return new Promise((resolve) => {
    const finish = (decision: PermissionDecision | null) => {
      if (!pending.has(id)) return;
      pending.delete(id);
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(decision);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), options.timeoutMs);

    pending.set(id, { info, resolve: finish });
    if (options.signal?.aborted) {
      finish(null);
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    options.onRegistered?.(info);
  });
}

/**
 * Claude Code's built-in question tool. It asks for permission like any other
 * tool, and a hook that allows it with `answers` filled in answers it for the
 * user, so the terminal never shows the question.
 */
export const ASK_USER_QUESTION = "AskUserQuestion";

/** The question texts of an `AskUserQuestion` input, or null when it has none. */
function questionTexts(toolInput: Record<string, unknown>): string[] | null {
  const { questions } = toolInput;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const texts = questions.map((q) => (typeof q?.question === "string" ? q.question : null));
  return texts.every((t): t is string => t !== null) ? texts : null;
}

/**
 * Answers a waiting `AskUserQuestion` prompt. `answers` maps each question's
 * text to the reply, which is how Claude Code reads them back. `gone` when it is
 * no longer waiting; `mismatch` when it isn't a question, or the answers don't
 * cover exactly its questions.
 */
export function answerQuestionPrompt(
  id: string,
  answers: Record<string, string>,
): "answered" | "gone" | "mismatch" {
  const entry = pending.get(id);
  if (!entry) return "gone";
  const { toolName, toolInput } = entry.info;
  const texts = toolName === ASK_USER_QUESTION ? questionTexts(toolInput) : null;
  const keys = Object.keys(answers);
  if (!texts || keys.length !== new Set(texts).size || !keys.every((k) => texts.includes(k))) {
    return "mismatch";
  }
  entry.resolve({ behavior: "allow", updatedInput: { ...toolInput, answers } });
  return "answered";
}

/** Answers a waiting request. False when it is no longer waiting. */
export function decidePermission(id: string, decision: PermissionDecision): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.resolve(decision);
  return true;
}

/** The requests still waiting, oldest first, optionally for one session. */
export function listPendingPermissions(filter: { sessionKey?: string } = {}) {
  return [...pending.values()]
    .map((p) => p.info)
    .filter((info) => !filter.sessionKey || info.sessionKey === filter.sessionKey)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Whether any request from a session is still waiting. */
export function hasPendingPermission(sessionKey: string): boolean {
  for (const p of pending.values()) if (p.info.sessionKey === sessionKey) return true;
  return false;
}

/** Longest one-line summary, so a long heredoc doesn't fill the attention row. */
const MAX_SUMMARY_CHARS = 160;

/** Cuts `text` to at most `max` characters, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One line describing what the tool wants to do, for the attention row and the
 * OS notification: the command for Bash, the path for file tools, otherwise
 * the first question for AskUserQuestion, otherwise just the tool's name.
 */
export function summarizePermission(toolName: string, toolInput: Record<string, unknown>): string {
  const pick = (key: string) => (typeof toolInput[key] === "string" ? toolInput[key] : null);
  const detail =
    pick("command") ??
    pick("file_path") ??
    pick("url") ??
    pick("pattern") ??
    (toolName === ASK_USER_QUESTION ? (questionTexts(toolInput)?.[0] ?? null) : null);
  const line = detail ? `${toolName}: ${detail.replace(/\s+/g, " ").trim()}` : toolName;
  return truncate(line, MAX_SUMMARY_CHARS);
}

/**
 * The stdout a `PermissionRequest` hook prints to apply a decision, or null for
 * no decision, which leaves the prompt to Claude Code's own dialog.
 */
export function hookOutputFor(decision: PermissionDecision | null): Record<string, unknown> | null {
  if (!decision || decision.behavior === "terminal") return null;
  const body =
    decision.behavior === "allow"
      ? {
          behavior: "allow",
          ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
        }
      : { behavior: "deny", ...(decision.message ? { message: decision.message } : {}) };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } };
}

/** Test helper: drops every waiting request without answering it. */
export function resetPendingPermissions(): void {
  for (const p of [...pending.values()]) p.resolve(null);
}
