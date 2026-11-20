import type { PrInsight } from "../../../lib/pr/insights";
import type { DiffSide, ReviewThread } from "../../../lib/pr/types";

/**
 * Where a file's comments and answers hang in the editor, worked out apart
 * from Monaco so it can be tested without one.
 */

/** A line on one side that has something hanging below it. */
export interface ZoneAnchor {
  side: DiffSide;
  line: number;
}

/**
 * A file's threads, split into those the editor can place under a line and
 * those it can't: a thread the provider has marked outdated, or one with no
 * line left on the current diff, is listed above the editor instead.
 */
export function splitThreads(
  threads: readonly ReviewThread[],
  path: string,
): { inline: ReviewThread[]; outdated: ReviewThread[] } {
  const inline: ReviewThread[] = [];
  const outdated: ReviewThread[] = [];
  for (const thread of threads) {
    if (thread.path !== path) continue;
    if (thread.isOutdated || thread.line == null) outdated.push(thread);
    else inline.push(thread);
  }
  return { inline, outdated };
}

const anchorId = (a: ZoneAnchor) => `${a.side}:${a.line}`;

/**
 * Every line with comments below it: a thread's last line, a comment posted
 * this session that the provider hasn't echoed yet, and the open composer.
 * One anchor per line and side, so each becomes a single zone holding all of
 * them, ordered top to bottom.
 */
export function commentAnchors(
  threads: readonly ReviewThread[],
  pending: readonly ZoneAnchor[],
  composer: ZoneAnchor | null,
): ZoneAnchor[] {
  const byId = new Map<string, ZoneAnchor>();
  const add = (a: ZoneAnchor) => byId.set(anchorId(a), { side: a.side, line: a.line });
  for (const t of threads) if (t.line != null) add({ side: t.side, line: t.line });
  for (const p of pending) add(p);
  if (composer) add(composer);
  return sortAnchors([...byId.values()]);
}

/**
 * The head lines with an answer below them, or the question composer. An
 * answer hangs under the last line it was asked about, as in the classic diff.
 */
export function insightLines(
  insights: readonly PrInsight[] | undefined,
  asking: { endLine: number } | null,
): number[] {
  const lines = new Set((insights ?? []).map((i) => i.endLine));
  if (asking) lines.add(asking.endLine);
  return [...lines].sort((a, b) => a - b);
}

function sortAnchors(anchors: ZoneAnchor[]): ZoneAnchor[] {
  return anchors.sort(
    (a, b) => a.line - b.line || (a.side === b.side ? 0 : a.side < b.side ? -1 : 1),
  );
}

/** Lines `start` to `end` (1-based, inclusive) of `content`, sent with a question. */
export function linesText(content: string, start: number, end: number): string {
  return content
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(start, end))
    .join("\n");
}

/**
 * Comments per file, replies and outdated threads included, so a tree row's
 * count matches what the file's tab lists.
 */
export function commentCountsByPath(threads: readonly ReviewThread[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of threads) {
    if (!t.path) continue;
    counts.set(t.path, (counts.get(t.path) ?? 0) + t.comments.length);
  }
  return counts;
}

/** Open (unresolved) threads per file, which a tree flags as still needing an answer. */
export function openThreadsByPath(threads: readonly ReviewThread[]): Set<string> {
  return new Set(threads.filter((t) => t.path && !t.isResolved).map((t) => t.path as string));
}
