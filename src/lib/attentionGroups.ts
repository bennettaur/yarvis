import { sessionWorkspaceId } from "../components/shell/terminalTabs/sessionIds";
import {
  type AttentionItem,
  type AttentionKind,
  type AttentionScope,
  hasAnswerDialog,
  headsDownQuestionId,
} from "./attention";

/**
 * Folds the pending stream into one entry per origin, so a workspace that asks
 * three times in a row reads as one thing wanting the user rather than three.
 * Grouping is by workspace when the item has one — that is the unit the user
 * navigates to and the unit a clear covers — and by session otherwise, which
 * keeps a standalone terminal tab's items together.
 */

export interface AttentionGroup {
  key: string;
  /** Every item in the group, newest-first. */
  items: AttentionItem[];
  /** The item the row speaks for: the most urgent, breaking ties by recency. */
  lead: AttentionItem;
  /** Distinct sessions represented, so a row can say which tabs are involved. */
  sessionKeys: string[];
  /** What clearing this group covers, matching how it was grouped. */
  scope: AttentionScope;
}

/**
 * Urgency order for picking a group's lead: blocked (permission, question, idle)
 * beats broken, which beats a nudge, which beats finished. Lower sorts first.
 */
const KIND_RANK: Record<AttentionKind, number> = {
  permission: 0,
  question: 1,
  idle: 2,
  error: 3,
  info: 4,
  completed: 5,
};

function moreUrgent(a: AttentionItem, b: AttentionItem): boolean {
  if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] < KIND_RANK[b.kind];
  return a.seq > b.seq;
}

/**
 * Groups pending items, preserving the incoming newest-first order both between
 * groups (by the newest item each holds) and within them.
 */
export function groupAttentionItems(items: AttentionItem[]): AttentionGroup[] {
  const groups = new Map<string, AttentionGroup>();

  for (const item of items) {
    const scope: AttentionScope = item.workspaceId
      ? { workspaceId: item.workspaceId }
      : item.sessionKey
        ? { sessionKey: item.sessionKey }
        : {};
    // Derived from the scope so the two can't drift apart.
    const key = scope.workspaceId
      ? `workspace:${scope.workspaceId}`
      : scope.sessionKey
        ? `session:${scope.sessionKey}`
        : `item:${item.id}`;

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        items: [item],
        lead: item,
        sessionKeys: item.sessionKey ? [item.sessionKey] : [],
        scope,
      });
      continue;
    }
    existing.items.push(item);
    if (moreUrgent(item, existing.lead)) existing.lead = item;
    if (item.sessionKey && !existing.sessionKeys.includes(item.sessionKey)) {
      existing.sessionKeys.push(item.sessionKey);
    }
  }

  return [...groups.values()];
}

/**
 * The next prompt to open once `done`'s dialog has nothing left: the oldest
 * other item from a session in the same workspace that also opens a dialog.
 *
 * - `done`'s own session is skipped: its dialog already went through
 *   everything that session had waiting, and its item may not have left the
 *   stream yet.
 * - Outside a workspace nothing follows: a session's dialog covers that
 *   session, and the heads-down dialog covers every open heads-down question.
 */
export function nextAnswerable(items: AttentionItem[], done: AttentionItem): AttentionItem | null {
  if (!done.workspaceId) return null;
  const candidates = items.filter(
    (i) =>
      i.workspaceId === done.workspaceId &&
      i.sessionKey !== done.sessionKey &&
      // Judged by the session id, as auto-open is, so a question whose session
      // runs elsewhere can't join this workspace's stack by naming it.
      i.sessionKey !== null &&
      sessionWorkspaceId(i.sessionKey) === done.workspaceId &&
      // Heads-down items have no workspace, so one that names a workspace isn't heads-down's.
      !headsDownQuestionId(i) &&
      hasAnswerDialog(i),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((oldest, i) => (i.seq < oldest.seq ? i : oldest));
}
