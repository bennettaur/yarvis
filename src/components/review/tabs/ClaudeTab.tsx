import { useCallback, useEffect, useRef, useState } from "react";
import { type DisplayError, formatError } from "../../../lib/errors";
import { killPty, ptyExists } from "../../../lib/pty";
import { reviewClaudeSessionId, startReviewClaudeSession } from "../../../lib/reviewWorkspaces/api";
import ErrorNotice from "../../ErrorNotice";
import LoadingIndicator from "../../LoadingIndicator";
import TerminalPanel from "../../TerminalPanel";
import type { TabContext } from "./types";

type SessionState =
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "failed"; error: DisplayError };

/**
 * Claude Code for the workspace, reading every PR checked out in it, for asking
 * questions about the changes. The sidecar starts it locked down (see
 * `sidecar/src/reviewWorkspaces/claudeSession.ts`); this tab only starts it
 * when none is running and attaches to it.
 *
 * The terminal is mounted only once the session exists: attaching to an id
 * with no session spawns a plain shell under it instead.
 */
export default function ClaudeTab({ ctx }: { ctx: TabContext }) {
  const { workspaceId, pr } = ctx;
  const sessionId = reviewClaudeSessionId(workspaceId);
  // The sidecar adds every ready PR and answers 409 when none is ready; this
  // only stops the tab from asking before its own PR is checked out.
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
    // A live session stays on screen while it's checked again, so a refresh of
    // the PR doesn't unmount the terminal mid-conversation.
    setSession((s) => (s.kind === "live" ? s : { kind: "starting" }));
    try {
      if (!(await ptyExists(sessionId))) await startReviewClaudeSession(workspaceId);
      settle({ kind: "live" });
    } catch (e) {
      settle({ kind: "failed", error: formatError(e) });
    }
  }, [workspaceId, sessionId]);

  useEffect(() => {
    if (checkoutReady) void start();
    return () => {
      attempt.current++;
    };
  }, [checkoutReady, start]);

  const restart = async () => {
    // A start still in flight mustn't mark the session live while it's killed.
    const mine = ++attempt.current;
    // Unmount the terminal first, so it doesn't sit on the session being killed.
    setSession({ kind: "starting" });
    try {
      await killPty(sessionId);
    } catch (e) {
      if (mine === attempt.current) setSession({ kind: "failed", error: formatError(e) });
      return;
    }
    await start();
  };

  // The PR's checkout going back to checking out (a refresh) leaves a running
  // session on screen.
  if (!checkoutReady && session.kind !== "live") {
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
        <span className="min-w-0 flex-1">
          Read-only: Claude Code reads every PR checked out here but can't edit them, and commands
          run sandboxed with no network. Your own settings, hooks and MCP servers aren't loaded. A
          PR added later joins on Restart.
        </span>
        <button
          type="button"
          onClick={() => void restart()}
          title="End this session and start a new one over every checked-out PR"
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
        >
          Restart
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalPanel sessionId={sessionId} embedded />
      </div>
    </div>
  );
}
