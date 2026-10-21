import { createHmac, timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workspaceAgentSessions } from "../db/schema.ts";

/**
 * The registry of Claude Code sessions started in each workspace, fed by the
 * SessionStart/SessionEnd hooks `claudeSettings.ts` installs. It answers three
 * questions: which sessions are attached to a workspace right now; which
 * process is the agent in a given PTY, which is what lets
 * `send_workspace_instruction` prove Claude is the one reading the prompt; and
 * which session the agent tab last ran, so the tab can resume it.
 */

/** Header carrying the PTY id, from the session's `YARVIS_SESSION_KEY`. */
export const SESSION_KEY_HEADER = "X-Yarvis-Session-Key";

/** Header carrying the PTY's `YARVIS_SESSION_TOKEN`; see `sessionTokenMatches`. */
export const SESSION_TOKEN_HEADER = "X-Yarvis-Session-Token";

/** End reason recorded for a session whose process exited without a SessionEnd. */
export const PROCESS_GONE_END_REASON = "process-gone";

export interface AgentSessionStart {
  workspaceId: string;
  sessionKey: string;
  claudeSessionId: string;
  pid: number;
  source: string | null;
  transcriptPath?: string | null;
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
        transcriptPath: start.transcriptPath ?? null,
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
 * The Claude session id the workspace's agent tab last ran, for the tab to
 * resume when it starts again. Null when there is nothing safe to resume:
 *
 * - no session was registered, or it registered no transcript;
 * - its transcript is gone (Claude Code prunes old ones), where `--resume`
 *   would fail and leave the tab at a bare shell;
 * - that session is still running anywhere in the workspace, where resuming
 *   would put a second process on the same transcript.
 *
 * The transcript path comes from a hook, so it counts only when its file name
 * is the session's own.
 */
export async function resumableAgentTabSessionId(
  db: Db,
  workspaceId: string,
): Promise<string | null> {
  const [latest] = await db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.workspaceId, workspaceId),
        eq(workspaceAgentSessions.sessionKey, `ws-claude:${workspaceId}`),
      ),
    )
    .orderBy(desc(workspaceAgentSessions.startedAt))
    .limit(1);
  if (!latest?.transcriptPath) return null;
  const transcript = latest.transcriptPath;
  if (!isAbsolute(transcript) || basename(transcript) !== `${latest.claudeSessionId}.jsonl`) {
    return null;
  }
  // Async so a transcript on a slow mount can't stall the event loop.
  const transcriptExists = await access(transcript).then(
    () => true,
    () => false,
  );
  if (!transcriptExists) return null;

  const running = await db
    .select({ pid: workspaceAgentSessions.pid })
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.workspaceId, workspaceId),
        eq(workspaceAgentSessions.claudeSessionId, latest.claudeSessionId),
        isNull(workspaceAgentSessions.endedAt),
      ),
    );
  if (running.some((r) => pidIsAlive(r.pid))) return null;
  return latest.claudeSessionId;
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
