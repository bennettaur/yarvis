import type { ReviewComment, ReviewThread } from "../lib/pr/types";

/**
 * An open, right-side review thread the viewer may reply to and resolve, with
 * one comment per body. Tests override only the fields they are about.
 */
export function reviewThread(
  overrides: Partial<ReviewThread> & { bodies?: string[] } = {},
): ReviewThread {
  const { bodies = ["hm"], ...rest } = overrides;
  const id = rest.id ?? "T1";
  const comments: ReviewComment[] = bodies.map((body, i) => ({
    id: `${id}-c${i}`,
    author: "octocat",
    body,
    createdAt: "2026-01-01T00:00:00Z",
  }));
  return {
    id,
    path: "foo.ts",
    line: 1,
    side: "RIGHT",
    isResolved: false,
    isOutdated: false,
    canReply: true,
    canResolve: true,
    canUnresolve: true,
    comments,
    ...rest,
  };
}
