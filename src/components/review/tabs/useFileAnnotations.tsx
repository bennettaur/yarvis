import { useMemo, useRef, useState } from "react";
import { usePrDetail } from "../../../lib/pr/cache";
import type { PrRef, SeenCommits } from "../../../lib/pr/types";
import InsightBlock from "../../pr/InsightCards";
import { LineCommentBlock, useLineComments } from "../../pr/LineComments";
import type { ThreadActions } from "../../pr/useThreadActions";
import { useThreadActions } from "../../pr/useThreadActions";
import type { EditorZone, LineAction } from "../editor";
import { commentAnchors, insightLines, linesText, splitThreads } from "./annotations";
import { useReviewInsights } from "./useReviewInsights";

export interface FileAnnotations {
  zones: EditorZone[];
  onLineAction: (action: LineAction) => void;
  /** Threads the editor can't place, for a list above it. */
  outdated: ReturnType<typeof splitThreads>["outdated"];
  outdatedActions: ThreadActions;
  /** How many threads the file has, placed or not. */
  threadCount: number;
  /** Why the last line action did nothing, for the toolbar to say. */
  notice: string | null;
  dismissNotice: () => void;
}

/**
 * What hangs in a file's editor: its review threads (reply, resolve), comments
 * posted this session, the comment composer, and the reviewer's own questions
 * and answers. The same set for a diff tab and a file tab, so a thread reads
 * and behaves the same wherever the file is open — and the same as in the
 * classic review, whose comment and insight blocks are what render here.
 */
export function useFileAnnotations({
  prRef,
  path,
  headContent,
  headSha,
  canComment,
  seen,
}: {
  prRef: PrRef;
  path: string;
  /** The head's text, sent with a question so the agent sees what the reader sees. */
  headContent: string;
  headSha: string;
  /** Providers take line comments only on files the PR changes. */
  canComment: boolean;
  /** The checkout's commits, recorded as where the user reviewed when they comment. */
  seen?: SeenCommits;
}): FileAnnotations {
  const detail = usePrDetail(prRef);
  const { inline, outdated } = useMemo(
    () => splitThreads(detail.data?.reviewThreads ?? [], path),
    [detail.data, path],
  );
  // `useLineComments` reads only the file's name off a PR file.
  const file = useMemo(
    () => ({ filename: path, status: "", additions: 0, deletions: 0, patch: null }),
    [path],
  );
  const comments = useLineComments(prRef, file, inline, seen);
  const outdatedActions = useThreadActions(prRef, outdated);
  const insights = useReviewInsights(prRef);
  const [notice, setNotice] = useState<string | null>(null);

  const onLineAction = (action: LineAction) => {
    setNotice(null);
    if (action.kind === "comment") {
      if (!canComment) {
        setNotice("Comments go on files the pull request changes.");
        return;
      }
      comments.openComposer(action.side, action.startLine);
      if (action.endLine > action.startLine)
        comments.openComposer(action.side, action.endLine, true);
      return;
    }
    // An answer is stored against the head's line numbers, so a question
    // about the old file would come back pinned to the wrong lines.
    if (action.side === "LEFT") {
      setNotice("Questions are asked about the new version of the file.");
      return;
    }
    insights.openAsk({
      path,
      startLine: action.startLine,
      endLine: action.endLine,
      selection: linesText(headContent, action.startLine, action.endLine),
    });
  };

  // The zones change only when a line gains or loses one, so the editor
  // doesn't re-place its view zones on every render. What a zone shows is read
  // through `live` when it renders, so it is always current.
  const live = useRef({ comments, insights });
  live.current = { comments, insights };
  const insightsForPath = insights.byPath.get(path);
  const asking = insights.asking?.path === path ? insights.asking : null;
  const zones = useMemo<EditorZone[]>(
    () => [
      ...commentAnchors(inline, comments.pending, comments.composer).map(
        (anchor): EditorZone => ({
          id: `comment:${anchor.side}:${anchor.line}`,
          side: anchor.side,
          afterLine: anchor.line,
          render: () => (
            <LineCommentBlock
              side={anchor.side}
              line={anchor.line}
              comments={live.current.comments}
            />
          ),
        }),
      ),
      ...insightLines(insightsForPath, asking).map(
        (line): EditorZone => ({
          id: `insight:${line}`,
          side: "RIGHT",
          afterLine: line,
          render: () => (
            <InsightBlock
              path={path}
              line={line}
              controller={live.current.insights}
              currentSha={headSha}
            />
          ),
        }),
      ),
    ],
    [inline, comments.pending, comments.composer, insightsForPath, asking, path, headSha],
  );

  return {
    zones,
    onLineAction,
    outdated,
    outdatedActions,
    threadCount: inline.length + outdated.length,
    notice,
    dismissNotice: () => setNotice(null),
  };
}
