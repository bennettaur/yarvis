import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workspaceAgentSessions } from "../db/schema.ts";

/**
 * The registry of Claude Code sessions running in each workspace, fed by the
 * SessionStart/SessionEnd hooks `claudeSettings.ts` installs. It answers two
 * questions: which sessions are attached to a workspace right now, and which
 * process is the agent in a given PTY, which is what lets
 * `send_workspace_instruction` prove Claude is the one reading the prompt.
 */

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
  firstSeenAt: Date;
  startedAt: Date;
  /** The earliest-registered session still running in the workspace. */
  primary: boolean;
}

/** End reason recorded for a session whose process exited without a SessionEnd. */
export const PROCESS_GONE = "process-gone";

/**
 * True when `key` names a PTY that belongs to `workspaceId`. The ingest token is
 * shared by every session, so this is what stops one workspace's session from
 * registering under another's agent tab.
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
 * True when a process with this pid exists. EPERM still means it exists; it
 * just belongs to someone else, which a recycled pid can.
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
 * The sessions running in a workspace, earliest-registered first. A row whose
 * process has gone is closed here rather than returned, because a killed or
 * crashed Claude never fires SessionEnd.
 */
export async function listLiveAgentSessions(
  db: Db,
  workspaceId: string,
  isAlive: (pid: number) => boolean = pidIsAlive,
): Promise<LiveAgentSession[]> {
  const rows = await db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.workspaceId, workspaceId),
        isNull(workspaceAgentSessions.endedAt),
      ),
    )
    .orderBy(asc(workspaceAgentSessions.firstSeenAt));

  const gone = rows.filter((r) => !isAlive(r.pid));
  if (gone.length > 0) {
    await db
      .update(workspaceAgentSessions)
      .set({ endedAt: sql`now()`, endReason: PROCESS_GONE })
      .where(
        inArray(
          workspaceAgentSessions.id,
          gone.map((r) => r.id),
        ),
      );
  }

  return rows
    .filter((r) => !gone.includes(r))
    .map((r, i) => ({
      sessionKey: r.sessionKey,
      claudeSessionId: r.claudeSessionId,
      pid: r.pid,
      source: r.source,
      firstSeenAt: r.firstSeenAt,
      startedAt: r.startedAt,
      primary: i === 0,
    }));
}
