import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workspaceAgentSessions, workspaces } from "../db/schema.ts";

/**
 * The registry of Claude Code sessions running in each workspace, fed by the
 * SessionStart/SessionEnd hooks `claudeSettings.ts` installs. It answers two
 * questions: which sessions are attached to a workspace right now, and which
 * process is the agent in a given PTY, which is what lets
 * `send_workspace_instruction` prove Claude is the one reading the prompt.
 */

/** Header carrying the PTY id, from the session's `YARVIS_SESSION_KEY`. */
export const SESSION_KEY_HEADER = "X-Yarvis-Session-Key";

/** Header carrying the PTY's `YARVIS_SESSION_TOKEN`; see `sessionTokenMatches`. */
export const SESSION_TOKEN_HEADER = "X-Yarvis-Session-Token";

// A row's `endReason` is either the reason Claude Code's SessionEnd hook sent
// or one of Yarvis's own below. Only Claude's `other` leaves it resumable.

/** End reason recorded for a session whose process exited without a SessionEnd. */
export const PROCESS_GONE_END_REASON = "process-gone";

/** End reason recorded when Yarvis stops a workspace's agent tab itself. */
export const STOPPED_END_REASON = "stopped";

/** End reason recorded for every session of a workspace being archived. */
export const ARCHIVED_END_REASON = "archived";

/** End reason recorded for a session Yarvis has relaunched with `--resume`. */
const RESUMED_END_REASON = "resumed";

/** End reason recorded for a session whose relaunch the core refused. */
const RESUME_FAILED_END_REASON = "resume-failed";

/**
 * The SessionEnd reason Claude Code reports when a signal ends it, which is
 * what the app quitting does: closing the PTY sends SIGHUP. Leaving with
 * `/exit`, Ctrl+C or Ctrl+D reports `prompt_input_exit` instead. Checked
 * against Claude Code 2.1.316. A session ended this way was cut off rather
 * than finished, so it stays resumable, and Yarvis's own stop, close and
 * archive overwrite it.
 */
const SIGNALLED_END_REASON = "other";

/** True while a row is still open, or was only cut off by a signal, so it can still be resumed. */
const UNFINISHED = sql<boolean>`(${workspaceAgentSessions.endedAt} IS NULL OR ${workspaceAgentSessions.endReason} = ${SIGNALLED_END_REASON})`;

/**
 * Claude Code session ids are UUIDs. Only that shape is ever resumed: the id
 * is put on Claude's command line, and one starting with `-` would be read as
 * a flag.
 */
const CLAUDE_SESSION_UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

export interface AgentSessionStart {
  workspaceId: string;
  sessionKey: string;
  claudeSessionId: string;
  pid: number;
  source: string | null;
}

export interface AgentSessionEnd {
  sessionKey: string;
  claudeSessionId: string;
  reason: string | null;
}

export interface LiveAgentSession {
  sessionKey: string;
  claudeSessionId: string;
  pid: number;
  source: string | null;
  startedAt: Date;
  /** The earliest-registered session still running in the workspace. */
  primary: boolean;
}

/**
 * True when `token` is the one the core put in the environment of the PTY named
 * `sessionKey`: an HMAC of the key under the sidecar's full-access bearer,
 * which no session holds (`session_token` in `src-tauri/src/pty.rs`). This is
 * what stops a process in one terminal from registering under another
 * terminal's key.
 */
export function sessionTokenMatches(bearer: string, sessionKey: string, token: string): boolean {
  // Buffer.from(hex) skips what it can't parse instead of throwing, so the
  // shape is checked first.
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const expected = createHmac("sha256", bearer).update(`session:${sessionKey}`).digest();
  return timingSafeEqual(Buffer.from(token, "hex"), expected);
}

/**
 * True when `key` names a PTY that belongs to `workspaceId`. The hooks bake in
 * the workspace id of the settings file they came from, while the key comes
 * from the terminal, so the two disagree when a Claude started in one
 * workspace's terminal runs from another's root. That registration is refused
 * rather than filed under the wrong workspace.
 */
export function sessionKeyBelongsTo(key: string, workspaceId: string): boolean {
  return key === `ws-claude:${workspaceId}` || key.startsWith(`ws:${workspaceId}/`);
}

/**
 * Records a session start. A resume arrives with a session id already on file,
 * so it reopens that row with the new pid rather than adding a second one, and
 * keeps `firstSeenAt` so the session stays primary if it was.
 */
export async function recordAgentSessionStart(db: Db, start: AgentSessionStart): Promise<void> {
  await db
    .insert(workspaceAgentSessions)
    .values(start)
    .onConflictDoUpdate({
      target: [workspaceAgentSessions.sessionKey, workspaceAgentSessions.claudeSessionId],
      set: {
        pid: start.pid,
        source: start.source,
        startedAt: sql`now()`,
        endedAt: null,
        endReason: null,
      },
    });
}

export async function recordAgentSessionEnd(db: Db, end: AgentSessionEnd): Promise<void> {
  await db
    .update(workspaceAgentSessions)
    .set({ endedAt: sql`now()`, endReason: end.reason })
    .where(
      and(
        eq(workspaceAgentSessions.sessionKey, end.sessionKey),
        eq(workspaceAgentSessions.claudeSessionId, end.claudeSessionId),
        isNull(workspaceAgentSessions.endedAt),
      ),
    );
}

/**
 * Marks a workspace's unfinished sessions ended, so nothing resumes them on
 * the next start. Covers every PTY in the workspace, or only `sessionKey` when
 * given. That includes one already cut off by a signal: killing the PTY is
 * what sent it, and its SessionEnd can land before this does.
 */
export async function endWorkspaceAgentSessions(
  db: Db,
  workspaceId: string,
  reason: string,
  sessionKey?: string,
): Promise<void> {
  await db
    .update(workspaceAgentSessions)
    .set({ endedAt: sql`now()`, endReason: reason })
    .where(
      and(
        eq(workspaceAgentSessions.workspaceId, workspaceId),
        UNFINISHED,
        sessionKey ? eq(workspaceAgentSessions.sessionKey, sessionKey) : undefined,
      ),
    );
}

export interface ResumableAgentSession {
  workspaceId: string;
  workspaceName: string;
  rootPath: string;
  claudeSessionId: string;
  pid: number;
}

/**
 * The agent-tab sessions to resume after a restart. For each active
 * workspace, that is the most recently started session in its `ws-claude:`
 * tab, when it is unfinished (see `UNFINISHED`) and its process is gone. A
 * session the user exited or Yarvis stopped is finished, and an archived
 * workspace is skipped. A live pid means only the sidecar restarted and the
 * session is still running.
 * A workspace still owed a kick-off is left out, since `resumeKickOffs` starts
 * its session.
 *
 * Must run before anything calls `reapAndListAgentSessions`, which closes
 * these same rows as `process-gone`.
 */
export async function findResumableAgentSessions(
  db: Db,
  isAlive: (pid: number) => boolean = pidIsAlive,
): Promise<ResumableAgentSession[]> {
  const rows = await db
    .select({
      workspaceId: workspaceAgentSessions.workspaceId,
      workspaceName: workspaces.name,
      rootPath: workspaces.rootPath,
      pendingBrief: workspaces.pendingBrief,
      sessionKey: workspaceAgentSessions.sessionKey,
      claudeSessionId: workspaceAgentSessions.claudeSessionId,
      pid: workspaceAgentSessions.pid,
      unfinished: UNFINISHED,
    })
    .from(workspaceAgentSessions)
    .innerJoin(workspaces, eq(workspaces.id, workspaceAgentSessions.workspaceId))
    .where(
      and(
        eq(workspaces.status, "active"),
        sql`${workspaceAgentSessions.sessionKey} = 'ws-claude:' || ${workspaceAgentSessions.workspaceId}::text`,
      ),
    )
    .orderBy(desc(workspaceAgentSessions.startedAt));

  const resumable: ResumableAgentSession[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // Only the newest session counts: an older one left open doesn't come
    // back after the user moved on to a later session that ended.
    if (seen.has(r.workspaceId)) continue;
    seen.add(r.workspaceId);
    if (!r.unfinished || r.pendingBrief || isAlive(r.pid)) continue;
    if (!CLAUDE_SESSION_UUID.test(r.claudeSessionId)) continue;
    resumable.push({
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceName,
      rootPath: r.rootPath,
      claudeSessionId: r.claudeSessionId,
      pid: r.pid,
    });
  }
  return resumable;
}

/**
 * Closes a session once Yarvis has tried to relaunch it, whether or not the
 * core took the launch, so each cut-off session gets one attempt rather than
 * one on every restart. A resumed Claude registers again under the same
 * session id, which reopens the row with its new pid; the pid match keeps
 * this from closing it if that registration lands first.
 */
export async function recordResumeAttempt(
  db: Db,
  session: ResumableAgentSession,
  launched: boolean,
): Promise<void> {
  await db
    .update(workspaceAgentSessions)
    .set({
      endedAt: sql`now()`,
      endReason: launched ? RESUMED_END_REASON : RESUME_FAILED_END_REASON,
    })
    .where(
      and(
        eq(workspaceAgentSessions.workspaceId, session.workspaceId),
        eq(workspaceAgentSessions.sessionKey, `ws-claude:${session.workspaceId}`),
        eq(workspaceAgentSessions.claudeSessionId, session.claudeSessionId),
        eq(workspaceAgentSessions.pid, session.pid),
        UNFINISHED,
      ),
    );
}

/**
 * True when a process with this pid exists. EPERM still means a process
 * exists, just one owned by another user (a recycled pid can be), so it counts
 * as alive.
 */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The sessions running in each of `workspaceIds`, earliest-registered first.
 * Also writes: a row whose process has gone is closed here rather than
 * returned, because a killed or crashed Claude never fires SessionEnd. Every
 * id asked about gets an entry, empty when nothing is running there.
 */
export async function reapAndListAgentSessions(
  db: Db,
  workspaceIds: string[],
  isAlive: (pid: number) => boolean = pidIsAlive,
): Promise<Map<string, LiveAgentSession[]>> {
  const byWorkspace = new Map<string, LiveAgentSession[]>(workspaceIds.map((id) => [id, []]));
  if (workspaceIds.length === 0) return byWorkspace;

  const rows = await db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        inArray(workspaceAgentSessions.workspaceId, workspaceIds),
        isNull(workspaceAgentSessions.endedAt),
      ),
    )
    .orderBy(asc(workspaceAgentSessions.firstSeenAt));

  const goneIds = new Set(rows.filter((r) => !isAlive(r.pid)).map((r) => r.id));
  if (goneIds.size > 0) {
    await db
      .update(workspaceAgentSessions)
      .set({ endedAt: sql`now()`, endReason: PROCESS_GONE_END_REASON })
      .where(inArray(workspaceAgentSessions.id, [...goneIds]));
  }

  for (const r of rows) {
    if (goneIds.has(r.id)) continue;
    const sessions = byWorkspace.get(r.workspaceId);
    sessions?.push({
      sessionKey: r.sessionKey,
      claudeSessionId: r.claudeSessionId,
      pid: r.pid,
      source: r.source,
      startedAt: r.startedAt,
      primary: sessions.length === 0,
    });
  }
  return byWorkspace;
}
