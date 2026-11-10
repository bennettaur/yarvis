import { useCallback, useEffect, useRef, useState } from "react";
import { type DisplayError, formatError } from "../../../lib/errors";
import { killPty, ptyExists } from "../../../lib/pty";
import { startReviewClaudeSession } from "../../../lib/reviewWorkspaces/api";
import ErrorNotice from "../../ErrorNotice";
import LoadingIndicator from "../../LoadingIndicator";
import TerminalPanel from "../../TerminalPanel";
import type { TabContext } from "./types";

/** The PTY id the core gives a review PR's session; matches `REVIEW_CLAUDE_PREFIX` in `pty.rs`. */
const reviewClaudeSessionId = (prId: string) => `review-claude:${prId}`;

type SessionState =
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "failed"; error: DisplayError };

/**
 * Claude Code running in the PR's checkout, for asking questions about the
 * change. The sidecar starts it locked down (see
 * `sidecar/src/reviewWorkspaces/claudeSession.ts`); this tab only starts it
 * when none is running and attaches to it.
 *
 * The terminal is mounted only once the session exists: attaching to an id
 * with no session spawns a plain shell under it instead.
 */
export default function ClaudeTab({ ctx }: { ctx: TabContext }) {
  const { workspaceId, pr } = ctx;
  const sessionId = reviewClaudeSessionId(pr.id);
  // The same test the sidecar's `requireCheckout` makes before it starts one.
  const checkoutReady = pr.status === "ready" && pr.worktreeStatus === "ready" && !!pr.headSha;
  const [session, setSession] = useState<SessionState>({ kind: "starting" });
  // Only the latest start may set the state, so a slow one that finishes after
  // a later start (or after the tab went away) can't overwrite it.
  const attempt = useRef(0);

  const start = useCallback(async () => {
    const mine = ++attempt.current;
    const settle = (next: SessionState) => {
      if (mine === attempt.current) setSession(next);
    };
    setSession({ kind: "starting" });
    try {
      if (!(await ptyExists(sessionId))) await startReviewClaudeSession(workspaceId, pr.id);
      settle({ kind: "live" });
    } catch (e) {
      settle({ kind: "failed", error: formatError(e) });
    }
  }, [workspaceId, pr.id, sessionId]);

  useEffect(() => {
    if (checkoutReady) void start();
    return () => {
      attempt.current++;
    };
  }, [checkoutReady, start]);

  const restart = async () => {
    // Unmount the terminal first, so it doesn't sit on the session being killed.
    setSession({ kind: "starting" });
    try {
      await killPty(sessionId);
    } catch (e) {
      setSession({ kind: "failed", error: formatError(e) });
      return;
    }
    await start();
  };

  if (!checkoutReady) {
    return (
      <p className="p-4 text-sm text-zinc-400">Claude Code starts once the PR is checked out.</p>
    );
  }
  if (session.kind === "failed") {
    return (
      <div className="p-4">
        <ErrorNotice
          error={session.error}
          actions={
            <button
              type="button"
              onClick={() => void start()}
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }
  if (session.kind === "starting") {
    return (
      <div className="p-4">
        <LoadingIndicator label="Starting Claude Code…" />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
        <span className="min-w-0 flex-1 truncate">
          Read-only: Claude Code can read the checkout but not edit it, and commands run sandboxed
          with no network. Your own settings, hooks and MCP servers aren't loaded.
        </span>
        <button
          type="button"
          onClick={() => void restart()}
          title="End this session and start a new one"
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
        >
          Restart
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalPanel sessionId={sessionId} cwd={pr.worktreePath} embedded />
      </div>
    </div>
  );
}
