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

/** What the user chose. `terminal` hands the prompt back to Claude Code's own dialog. */
export type PermissionDecision =
  | { behavior: "allow" }
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

interface Pending {
  info: PermissionRequestInfo;
  resolve: (decision: PermissionDecision | null) => void;
}

const pending = new Map<string, Pending>();

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
  options: { timeoutMs: number; signal?: AbortSignal; onRegistered?: (id: string) => void },
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
    options.onRegistered?.(id);
  });
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
const SUMMARY_MAX = 160;

/**
 * One line describing what the tool wants to do, for the attention row and the
 * OS notification: the command for Bash, the path for file tools, otherwise
 * just the tool's name.
 */
export function summarizePermission(toolName: string, toolInput: Record<string, unknown>): string {
  const pick = (key: string) => (typeof toolInput[key] === "string" ? toolInput[key] : null);
  const detail = pick("command") ?? pick("file_path") ?? pick("url") ?? pick("pattern");
  const line = detail ? `${toolName}: ${detail.replace(/\s+/g, " ").trim()}` : toolName;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/**
 * The stdout a `PermissionRequest` hook prints to apply a decision, or null for
 * no decision, which leaves the prompt to Claude Code's own dialog.
 */
export function hookOutputFor(decision: PermissionDecision | null): Record<string, unknown> | null {
  if (!decision || decision.behavior === "terminal") return null;
  const body =
    decision.behavior === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", ...(decision.message ? { message: decision.message } : {}) };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } };
}

/** Test helper: drops every waiting request without answering it. */
export function resetPendingPermissions(): void {
  for (const p of [...pending.values()]) p.resolve(null);
}
