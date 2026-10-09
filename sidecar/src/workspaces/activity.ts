import { runSpecialist } from "../agents/run.ts";
import { getLatestSessionActivity, type SessionActivity } from "../cc/sessions.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";

/**
 * What a workspace's coding-agent session was last doing, read from the Claude
 * Code transcripts under `~/.claude/projects` and recapped by a low-tier model.
 *
 * Read on demand when the chat agent asks, rather than swept on a schedule like
 * the transcript digest, and kept out of memory: the answer is only true until
 * the session's next turn.
 */

/** Prompts handed to the recap; enough to show the thread without the whole session. */
const PROMPTS_PER_RECAP = 5;

/** Each prompt is cut to this, so one pasted log can't crowd out the rest. */
const MAX_PROMPT_CHARS = 2_000;

/** The agent's reply is cut to its end, which is where it says how things stand. */
const MAX_REPLY_CHARS = 3_000;

/** Bounds the recap cache. Each entry is a few sentences. */
const MAX_CACHED_RECAPS = 100;

/**
 * Claude Code's project directory for a working directory: every character
 * outside `[A-Za-z0-9]` becomes `-`. A workspace's session runs at its root.
 */
export function ccProjectDirFor(rootPath: string): string {
  return rootPath.replace(/[^A-Za-z0-9]/g, "-");
}

/** Renders a session's recent activity as material for the recap. */
export function activityMaterial(activity: SessionActivity): string {
  const prompts = activity.prompts.map((p, i) => {
    const text =
      p.text.length > MAX_PROMPT_CHARS ? `${p.text.slice(0, MAX_PROMPT_CHARS)}…` : p.text;
    return `Prompt ${i + 1}${p.timestamp ? ` (${p.timestamp})` : ""}:\n${text}`;
  });
  const reply = activity.lastReply
    ? `Agent's latest reply${activity.lastReply.timestamp ? ` (${activity.lastReply.timestamp})` : ""}:\n${
        activity.lastReply.text.length > MAX_REPLY_CHARS
          ? `…${activity.lastReply.text.slice(-MAX_REPLY_CHARS)}`
          : activity.lastReply.text
      }`
    : "The agent has not replied yet.";
  return [...prompts, reply].join("\n\n");
}

export interface RecapInput {
  config: Config;
  db: Db;
  workspaceName: string;
  activity: SessionActivity;
}

/** Writes the recap; injectable so tests run without a model. */
export type ActivityRecapper = (input: RecapInput) => Promise<string>;

export const recapActivity: ActivityRecapper = async ({ config, db, workspaceName, activity }) => {
  const run = await runSpecialist({
    config,
    db,
    name: "workspace-recap",
    task: `Recap where the coding-agent session in the workspace "${workspaceName}" stands.`,
    material: activityMaterial(activity),
  });
  return run.text.trim();
};

// Keyed by session and modification time, so asking twice about an idle
// session costs one model call and a session that moved on is recapped afresh.
const recapCache = new Map<string, string>();

export interface WorkspaceSessionActivity {
  sessionId: string;
  lastActivityAt: string | null;
  /** Null when the session has no typed prompts yet, so there was nothing to recap. */
  recap: string | null;
}

/**
 * The latest agent session in a workspace and a recap of it, or null when no
 * Claude Code session has run at the workspace's root.
 */
export async function workspaceSessionActivity(
  input: { config: Config; db: Db; workspaceName: string; rootPath: string },
  recapper: ActivityRecapper = recapActivity,
): Promise<WorkspaceSessionActivity | null> {
  const activity = await getLatestSessionActivity(
    ccProjectDirFor(input.rootPath),
    PROMPTS_PER_RECAP,
  );
  if (!activity) return null;
  const base = { sessionId: activity.sessionId, lastActivityAt: activity.lastActivityAt };
  if (activity.prompts.length === 0) return { ...base, recap: null };

  const key = `${activity.sessionId}:${activity.mtimeMs}`;
  let recap = recapCache.get(key);
  if (recap === undefined) {
    recap = await recapper({ ...input, activity });
    recapCache.set(key, recap);
    if (recapCache.size > MAX_CACHED_RECAPS) {
      const oldest = recapCache.keys().next().value;
      if (oldest !== undefined) recapCache.delete(oldest);
    }
  }
  return { ...base, recap: recap || null };
}

/** Empties the recap cache, for tests that reuse a session id. */
export function clearRecapCache(): void {
  recapCache.clear();
}
