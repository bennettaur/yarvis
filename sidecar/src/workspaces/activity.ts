import { runSpecialist } from "../agents/run.ts";
import type { ActivityTurn, RecentActivity } from "../cc/parse.ts";
import { ccProjectDirFor, latestSessionFile, readSessionActivity } from "../cc/sessions.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { redactSecrets } from "../llm/errors.ts";

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

/**
 * The prompt asks for a few sentences; this holds a model that ignores it to a
 * size that can't flood the chat agent's context once per workspace.
 */
const MAX_RECAP_CHARS = 1_000;

/** Bounds the recap cache. Each entry is a few sentences. */
const MAX_CACHED_RECAPS = 100;

function formatPrompt(prompt: ActivityTurn, index: number): string {
  const text =
    prompt.text.length > MAX_PROMPT_CHARS
      ? `${prompt.text.slice(0, MAX_PROMPT_CHARS)}…`
      : prompt.text;
  return `Prompt ${index + 1}${prompt.timestamp ? ` (${prompt.timestamp})` : ""}:\n${text}`;
}

function formatReply(reply: ActivityTurn | null): string {
  if (!reply) return "The agent has not replied yet.";
  const text =
    reply.text.length > MAX_REPLY_CHARS ? `…${reply.text.slice(-MAX_REPLY_CHARS)}` : reply.text;
  return `Agent's latest reply${reply.timestamp ? ` (${reply.timestamp})` : ""}:\n${text}`;
}

/**
 * Renders a session's recent activity as material for the recap. Credential
 * shapes are scrubbed first: people paste tokens into prompts, and the low tier
 * can be a different provider from the one the session used.
 */
export function activityMaterial(activity: RecentActivity): string {
  return redactSecrets(
    [...activity.prompts.map(formatPrompt), formatReply(activity.lastReply)].join("\n\n"),
  );
}

export interface RecapInput {
  config: Config;
  db: Db;
  activity: RecentActivity;
  /** The chat turn's signal, so stopping the turn stops the recap. */
  signal?: AbortSignal;
}

/** Writes the recap; injectable so tests run without a model. */
export type ActivityRecapper = (input: RecapInput) => Promise<string>;

export const recapActivity: ActivityRecapper = async ({ config, db, activity, signal }) => {
  const run = await runSpecialist({
    config,
    db,
    name: "workspace-recap",
    // No workspace name here: it can come from an issue title, and the task line
    // sits outside the material's fence.
    task: "Recap where this coding-agent session stands.",
    material: activityMaterial(activity),
    signal,
  });
  return run.text.trim().slice(0, MAX_RECAP_CHARS);
};

export interface WorkspaceSessionRecap {
  sessionId: string;
  lastActivityAt: string | null;
  /** Null when there was nothing to recap (no typed prompts yet) or the model returned nothing. */
  recap: string | null;
}

// Keyed by session and modification time: an unchanged file needs neither a
// second read nor a second model call, and a session that moved on is recapped
// afresh. Holds the promise so two asks while a recap is running share it.
const recapCache = new Map<string, Promise<WorkspaceSessionRecap>>();

function cached(
  key: string,
  load: () => Promise<WorkspaceSessionRecap>,
): Promise<WorkspaceSessionRecap> {
  const hit = recapCache.get(key);
  if (hit) return hit;
  const result = load();
  recapCache.set(key, result);
  // A failure isn't kept, so the next ask tries again.
  result.catch(() => recapCache.delete(key));
  if (recapCache.size > MAX_CACHED_RECAPS) {
    const oldest = recapCache.keys().next().value;
    if (oldest !== undefined) recapCache.delete(oldest);
  }
  return result;
}

/**
 * The latest agent session in a workspace and a recap of it, or null when no
 * Claude Code session has run at the workspace's root.
 */
export async function recapWorkspaceSession(
  input: { config: Config; db: Db; rootPath: string; signal?: AbortSignal },
  recapper: ActivityRecapper,
): Promise<WorkspaceSessionRecap | null> {
  const projectDir = ccProjectDirFor(input.rootPath);
  const session = await latestSessionFile(projectDir);
  if (!session) return null;

  return cached(`${session.sessionId}:${session.mtimeMs}`, async () => {
    const activity = await readSessionActivity(projectDir, session, PROMPTS_PER_RECAP);
    const base = { sessionId: session.sessionId, lastActivityAt: activity.lastActivityAt };
    if (activity.prompts.length === 0) return { ...base, recap: null };
    const recap = await recapper({
      config: input.config,
      db: input.db,
      activity,
      signal: input.signal,
    });
    return { ...base, recap: recap || null };
  });
}

/** Empties the recap cache, for tests that reuse a session id. */
export function clearRecapCache(): void {
  recapCache.clear();
}
