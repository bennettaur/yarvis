import { listAttention } from "../attention/service.ts";
import { ccProjectDirFor, latestSessionFile } from "../cc/sessions.ts";
import type { Db } from "../db/client.ts";
import type { AttentionItemRow } from "../db/schema.ts";

/**
 * Whether a workspace's agent is in the middle of something, so a caller about
 * to type at its prompt can ask the user first.
 *
 * Nothing reports "working" directly: the hooks a Yarvis session runs only say
 * when it is *waiting* — a `completed` item when a turn ends, `idle` when it sits
 * at its prompt, `permission` when it is blocked on a tool approval. What a
 * working agent does do is write its transcript. So a transcript written after
 * the last waiting signal is a turn under way, and a pending permission prompt
 * is a dialog the typed text would answer instead of reaching the agent.
 *
 * This is a guess, not a guard. It errs towards asking: a session killed
 * mid-turn reads as busy until it next finishes one, and so does a workspace
 * where another Claude session was run by hand at the workspace root, since
 * its transcript lands in the same project folder. It cannot see the other
 * dialogs an agent shows (plan approval, a question, a menu), which raise no
 * hook, so typing can still answer one of those. A caller should only ask it
 * about a session it knows is running.
 */

/**
 * How long after a waiting signal a transcript write still counts as part of
 * the turn that signal ended. Claude Code appends a few bookkeeping lines (the
 * Stop hook's own result among them) once the turn is over.
 */
export const TRANSCRIPT_SETTLE_MS = 10_000;

/** What the user is told when the agent looks busy. */
export const AGENT_WORKING_REASON = "The agent is working on something.";
export const AGENT_PERMISSION_REASON =
  "The agent is waiting on a permission prompt. Answer it in the workspace first, then try again.";

/**
 * The decision itself, separated from where its inputs come from. `items` are
 * the workspace's attention items in any status; only the agent tab's own hook
 * items count.
 */
export function agentBusyReason(input: {
  sessionKey: string;
  items: Pick<
    AttentionItemRow,
    "sessionKey" | "source" | "kind" | "status" | "createdAt" | "updatedAt"
  >[];
  /** When the session's transcript was last written, or null when it has none. */
  transcriptMtimeMs: number | null;
}): string | null {
  const own = input.items.filter(
    (i) => i.sessionKey === input.sessionKey && i.source === "claude-hook",
  );
  if (own.some((i) => i.kind === "permission" && i.status === "pending")) {
    return AGENT_PERMISSION_REASON;
  }
  // A session that has never written a transcript hasn't been given anything.
  if (input.transcriptMtimeMs === null) return null;

  // A pending item coalesces repeat signals onto itself, bumping `updatedAt`;
  // once read or resolved its `updatedAt` is when the user looked, not when the
  // agent signalled, so `createdAt` is the safer floor there.
  const signalledAt = own
    .filter((i) => i.kind === "completed" || i.kind === "idle")
    .map((i) => (i.status === "pending" ? i.updatedAt : i.createdAt).getTime());
  const lastWaiting = signalledAt.length ? Math.max(...signalledAt) : null;
  if (lastWaiting === null || input.transcriptMtimeMs > lastWaiting + TRANSCRIPT_SETTLE_MS) {
    return AGENT_WORKING_REASON;
  }
  return null;
}

/** Reads the inputs for {@link agentBusyReason} for a workspace's agent tab. */
export async function workspaceAgentBusyReason(
  db: Db,
  workspace: { id: string; rootPath: string },
): Promise<string | null> {
  const sessionKey = `ws-claude:${workspace.id}`;
  const [items, transcript] = await Promise.all([
    listAttention(db, { workspaceId: workspace.id, limit: 100 }),
    // The agent tab is launched at the workspace root, so that is the project
    // its transcripts are filed under.
    latestSessionFile(ccProjectDirFor(workspace.rootPath)).catch(() => null),
  ]);
  return agentBusyReason({
    sessionKey,
    items,
    transcriptMtimeMs: transcript?.mtimeMs ?? null,
  });
}
