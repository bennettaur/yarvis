import { runSpecialist } from "../agents/run.ts";
import { getTranscript, listProjects, listSessionFiles } from "../cc/sessions.ts";
import type { Db } from "../db/client.ts";
import { ccSessionDigests } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import { getJobConfig } from "./config.ts";
import { dailyAt } from "./schedule.ts";
import type { JobDefinition } from "./scheduler.ts";

/**
 * Nightly digest of the Claude Code sessions run on this machine.
 *
 * The transcripts under `~/.claude/projects` are the most complete record of
 * what the user actually did — including the reasoning and the corrections they
 * gave an agent, which no event log captures. This reads the ones that are new
 * or have grown since the last sweep, and writes each as a `session-summary`,
 * plus a separate `agent-feedback` memory when the session contained guidance
 * about how an agent should behave (that is the part worth surfacing again in a
 * future session, so it doesn't stay buried in one transcript).
 *
 * Runs before the day rollup so its summaries are part of the day's material.
 * Off until the user opts in — see the consent gate in `run`.
 */

/**
 * Transcript modification times are fractional on APFS; the column they are
 * stored in is an integer. Both the write and the "unchanged since last sweep"
 * comparison go through this, because comparing a stored integer against a raw
 * fractional mtime never holds — every session would look grown on every sweep
 * and be re-summarized nightly, one duplicate memory at a time.
 *
 * Floor rather than round so the stamp is never *later* than the file: a stamp in
 * the future would make a session that really did grow look unchanged.
 */
const mtimeStamp = (mtimeMs: number): number => Math.floor(mtimeMs);

/** Sessions digested per run, so a first sweep over months of history is bounded. */
const MAX_SESSIONS_PER_RUN = 12;

/**
 * Ceiling on a digested section. The summarizer's answer is model-composed from
 * an untrusted transcript, and the `agent-feedback` section becomes a memory the
 * chat agent reads as guidance about its own behaviour — so its size is bounded
 * here rather than trusting the prompt to have been followed.
 */
const MAX_SECTION_CHARS = 2_000;

/** A transcript shorter than this was an aborted session, not work. */
const MIN_TRANSCRIPT_CHARS = 400;

/** Cap on transcript text handed to the summarizer, in characters. */
const MAX_TRANSCRIPT_CHARS = 20_000;

/**
 * Renders a transcript as material. Tool traffic is already reduced to markers
 * by `extractText`, so this keeps the turns and drops the empty ones.
 */
export function transcriptMaterial(
  entries: { role: string; text: string; timestamp: string | null }[],
): string {
  const lines = entries
    .filter((entry) => entry.text.trim())
    .map((entry) => `${entry.role}: ${entry.text.trim()}`);
  const joined = lines.join("\n\n");
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  // Keep both ends: the opening states the task, the end holds the outcome and
  // whatever the user said last, which is where corrections live.
  const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
  return `${joined.slice(0, half)}\n\n…(middle omitted)…\n\n${joined.slice(-half)}`;
}

export interface SessionDigest {
  work: string;
  decisions: string | null;
  feedback: string | null;
}

/**
 * Splits the summarizer's answer into its three labelled sections. The prompt
 * asks for the headers, but a model can still answer in prose — in that case the
 * whole answer is the work section, which is the useful default rather than a
 * dropped digest.
 */
export function parseSessionDigest(text: string): SessionDigest {
  const trimmed = text.trim();
  const section = (name: string): string | null => {
    // Not multiline-anchored: with the `m` flag `$` would end the capture at the
    // first newline, cutting a section down to its opening line.
    const match = trimmed.match(
      new RegExp(
        `(?:^|\\n)\\s*${name}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:WORK|DECISIONS|FEEDBACK):|$)`,
        "i",
      ),
    );
    const body = match?.[1]?.trim();
    if (!body || /^none\.?$/i.test(body)) return null;
    return body.slice(0, MAX_SECTION_CHARS);
  };
  const work = section("WORK");
  return {
    work: work ?? trimmed.slice(0, MAX_SECTION_CHARS * 2),
    decisions: section("DECISIONS"),
    feedback: section("FEEDBACK"),
  };
}

export const ccSessionDigestJob: JobDefinition = {
  name: "cc-session-digest",
  description:
    "Overnight, summarize new or extended Claude Code sessions into memories, including any feedback about how the agent should behave.",
  // An hour before the day rollup, so the day summary can include these.
  schedule: dailyAt(2),
  // A first sweep summarizes up to a dozen transcripts, each a model call.
  leaseMs: 30 * 60 * 1000,
  run: async ({ db, config }) => {
    // Consent gate. This is the one job that sends local data to an LLM
    // provider — transcripts hold whatever was pasted into a session — so it
    // does nothing until the user turns it on and names the projects it may
    // read. An empty allowlist means none, not all.
    const { ccDigestEnabled, ccDigestProjectDirs } = await getJobConfig(db);
    if (!ccDigestEnabled) {
      return { skipped: true, detail: "transcript digest is off (Settings → Assistant)" };
    }
    if (ccDigestProjectDirs.length === 0) {
      return { skipped: true, detail: "no project directories are allowed for the digest yet" };
    }
    const allowed = new Set(ccDigestProjectDirs);

    const digested = await db
      .select({
        sessionId: ccSessionDigests.sessionId,
        mtime: ccSessionDigests.sourceMtimeMs,
      })
      .from(ccSessionDigests);
    const seen = new Map(digested.map((d) => [d.sessionId, d.mtime]));

    // Newest projects first: a first run should cover what the user was doing
    // yesterday before it works backwards through history.
    const candidates: { projectDir: string; sessionId: string; mtimeMs: number }[] = [];
    for (const project of await listProjects()) {
      if (!allowed.has(project.dir)) continue;
      for (const file of await listSessionFiles(project.dir)) {
        const previous = seen.get(file.sessionId);
        // Re-summarize a session that grew: a resumed session's later half is
        // often where the work actually landed.
        if (previous !== undefined && previous >= mtimeStamp(file.mtimeMs)) continue;
        candidates.push({
          projectDir: project.dir,
          sessionId: file.sessionId,
          mtimeMs: file.mtimeMs,
        });
      }
    }
    if (candidates.length === 0) return { skipped: true, detail: "no new sessions" };

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const batch = candidates.slice(0, MAX_SESSIONS_PER_RUN);
    const memory = new PgVectorMemoryStore(db, await chooseEmbedder(config, db));
    let written = 0;
    let skipped = 0;

    for (const candidate of batch) {
      try {
        const entries = await getTranscript(candidate.projectDir, candidate.sessionId).catch(
          () => [] as Awaited<ReturnType<typeof getTranscript>>,
        );
        const material = transcriptMaterial(entries);
        if (material.length < MIN_TRANSCRIPT_CHARS) {
          // Recorded as digested anyway: an abandoned transcript will not grow, and
          // re-reading it every night costs a file read for nothing.
          await recordDigest(db, candidate, entries.length, null);
          skipped += 1;
          continue;
        }

        const run = await runSpecialist({
          config,
          db,
          name: "session-summarizer",
          task: [
            `Summarize this Claude Code session (project ${candidate.projectDir}).`,
            "Answer with exactly three sections, each on its own line and labelled:",
            "WORK: what the session worked on and where it got to.",
            "DECISIONS: choices made and why, or 'none'.",
            "FEEDBACK: instructions the user gave about how the agent should behave in future, or 'none'.",
          ].join(" "),
          material,
        });
        const digest = parseSessionDigest(run.text);
        if (!digest.work.trim()) {
          skipped += 1;
          continue;
        }

        const sourceRef = {
          type: "cc-session" as const,
          projectDir: candidate.projectDir,
          sessionId: candidate.sessionId,
        };
        const summary = await memory.add(
          [digest.work, digest.decisions ? `Decisions: ${digest.decisions}` : null]
            .filter(Boolean)
            .join("\n\n"),
          { kind: "session-summary", sourceRef },
        );
        if (digest.feedback) {
          // Stored separately so it can be recalled as guidance in its own right,
          // rather than only as part of the story of one session.
          await memory.add(digest.feedback, { kind: "agent-feedback", sourceRef });
        }
        await recordDigest(db, candidate, entries.length, summary.id);
        await emitEvent(db, {
          type: "cc.session_summarized",
          source: "jobs",
          payload: {
            projectDir: candidate.projectDir,
            sessionId: candidate.sessionId,
            memoryId: summary.id,
            hadFeedback: digest.feedback !== null,
          },
        });
        written += 1;
      } catch (e) {
        // One unreadable transcript, or one summarizer failure, must not cost the
        // rest of the night's batch. The digest row is not written, so it is
        // retried tomorrow.
        console.error(
          `[jobs] could not digest session ${candidate.sessionId}:`,
          e instanceof Error ? e.message : String(e),
        );
        skipped += 1;
      }
    }

    const remaining = candidates.length - batch.length;
    return {
      detail:
        `digested ${written} session(s), skipped ${skipped} short one(s)` +
        (remaining > 0 ? `, ${remaining} left for tomorrow` : ""),
    };
  },
};

/** Marks a transcript as digested at its current size. */
async function recordDigest(
  db: Db,
  candidate: { projectDir: string; sessionId: string; mtimeMs: number },
  entryCount: number,
  memoryId: string | null,
): Promise<void> {
  const values = {
    sessionId: candidate.sessionId,
    projectDir: candidate.projectDir,
    sourceMtimeMs: mtimeStamp(candidate.mtimeMs),
    entryCount,
    memoryId,
    updatedAt: new Date(),
  };
  await db
    .insert(ccSessionDigests)
    .values(values)
    .onConflictDoUpdate({ target: ccSessionDigests.sessionId, set: values });
}
