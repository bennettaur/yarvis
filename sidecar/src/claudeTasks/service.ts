import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunOutcome, ClaudeRunDeps } from "../agentRuns/service.ts";
import { startClaudeRun } from "../agentRuns/service.ts";
import { publish } from "../attention/hub.ts";
import { createAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { agentRuns } from "../db/schema.ts";
import { redactSecrets } from "../llm/errors.ts";

/**
 * Hands a self-contained piece of work — build a small website, write a brief,
 * draft a script — to a headless Claude Code run, without provisioning a
 * workspace. The run starts in a fresh, empty output folder and leaves its
 * files there; the chat that started it gets an attention item when it ends.
 *
 * It goes through `startClaudeRun`, so it has the same lockdown as the review
 * runs: no settings files, no MCP servers, no network, a sandboxed Bash, and a
 * spend ceiling. The task text is the chat model's own words, which may have
 * been composed after reading a web page or a ticket, so the run gets nothing
 * it could publish with.
 */

export const CLAUDE_TASK_RUN_KIND = "claude-task";

export const MAX_TITLE_CHARS = 80;
export const MAX_TASK_CHARS = 20_000;

/** A task is a one-off piece of work, not a project: these cap a run that loses its way. */
const MAX_BUDGET_USD = 5;
const MAX_TURNS = 150;
const TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Bash runs in Claude Code's sandbox, which keeps writes inside the output
 * folder and has no network. `acceptEdits` lets Write and Edit through for files
 * inside the folder only; an edit anywhere else would need a prompt nobody can
 * answer, so it is denied.
 */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash", "TodoWrite"];
const DISALLOWED_TOOLS = ["WebFetch", "WebSearch", "NotebookEdit", "Agent", "Task"];

const SYSTEM_PROMPT = [
  "You were handed a self-contained task by Yarvis, the user's personal assistant.",
  "The working directory is an empty folder created for this task: put everything you make there.",
  "You have no network access, so you cannot install packages; build with what is on this machine,",
  "and prefer plain HTML, CSS and JavaScript for anything that should open in a browser.",
  "Nobody can answer a question while you work: make reasonable choices and say what you assumed.",
  "When you are done, answer with a short summary of what you made and list every file the user",
  "should look at, by its path relative to the working directory.",
].join(" ");

const answerSchema = z.object({
  summary: z.string().describe("What you made and anything you assumed, in a few sentences"),
  files: z
    .array(
      z.object({
        path: z.string().describe("Relative to the working directory"),
        description: z.string(),
      }),
    )
    .describe("The files the user should look at, most important first"),
});

export type ClaudeTaskAnswer = z.infer<typeof answerSchema>;

export interface ClaudeTaskMeta {
  title: string;
  outputDir: string;
  /** The chat that started it, so the attention item can open it. Null from a delegated run. */
  chatSessionId: string | null;
}

export interface StartClaudeTaskInput {
  title: string;
  task: string;
  chatSessionId: string | null;
}

/** Where task folders go: beside the workspaces, so they are somewhere the user already looks. */
export function claudeTasksRoot(config: Pick<Config, "workspacesRoot">): string {
  return join(config.workspacesRoot, ".claude-tasks");
}

/**
 * Starts a task and returns once its run is registered. The run carries on in
 * the background; the attention item is raised when it ends.
 */
export async function startClaudeTask(
  db: Db,
  config: Pick<Config, "workspacesRoot">,
  input: StartClaudeTaskInput,
  deps: ClaudeRunDeps = {},
): Promise<{ runId: string; outputDir: string }> {
  const outputDir = join(claudeTasksRoot(config), randomUUID());
  mkdirSync(outputDir, { recursive: true });
  const meta: ClaudeTaskMeta = {
    title: input.title,
    outputDir,
    chatSessionId: input.chatSessionId,
  };
  const handle = await startClaudeRun(
    db,
    {
      kind: CLAUDE_TASK_RUN_KIND,
      targetKey: outputDir,
      cwd: outputDir,
      prompt: input.task,
      outputSchema: answerSchema,
      finishOutput: (answer) => ({ ...answer, files: filesInFolder(outputDir, answer.files) }),
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      permissionMode: "acceptEdits",
      appendSystemPrompt: SYSTEM_PROMPT,
      maxBudgetUsd: MAX_BUDGET_USD,
      maxTurns: MAX_TURNS,
      timeoutMs: TIMEOUT_MS,
      meta: { ...meta },
    },
    deps,
  );
  void handle.done
    .then((outcome) => notifyFinished(db, handle.id, meta, outcome))
    .catch((e) => console.error(`[claude-tasks] could not report the end of ${handle.id}:`, e));
  return { runId: handle.id, outputDir };
}

/**
 * Keeps only the listed files that exist inside the folder. The list is the
 * model's claim, and its paths are shown to the user and opened from the chat,
 * so one naming a file outside the folder or one it never wrote is dropped.
 */
export function filesInFolder(
  outputDir: string,
  files: ClaudeTaskAnswer["files"],
): ClaudeTaskAnswer["files"] {
  const root = realpathSync(outputDir);
  return files.filter((file) => {
    if (isAbsolute(file.path)) return false;
    const target = resolve(root, file.path);
    if (!existsSync(target) || !statSync(target).isFile()) return false;
    const real = realpathSync(target);
    const rel = relative(root, real);
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  });
}

/** Longest attention body; the full summary is one tool call away. */
const MAX_BODY_CHARS = 300;

async function notifyFinished(
  db: Db,
  runId: string,
  meta: ClaudeTaskMeta,
  outcome: AgentRunOutcome<ClaudeTaskAnswer>,
): Promise<void> {
  if (outcome.status === "cancelled") return;
  const succeeded = outcome.status === "succeeded";
  // The body is model text, shown in the bell and as an OS notification, so it
  // is one redacted line. The title is ours, so injected text can't pose as an
  // app alert.
  const line = redactSecrets(
    ((succeeded ? outcome.output?.summary : outcome.error) ?? "").replace(/\s+/g, " ").trim(),
  );
  const item = await createAttention(db, {
    source: "chat-agent",
    sessionKey: `claude-task:${runId}`,
    kind: succeeded ? "info" : "error",
    title: succeeded
      ? `Claude Code finished: ${meta.title}`
      : `Claude Code task failed: ${meta.title}`,
    body: line ? (line.length > MAX_BODY_CHARS ? `${line.slice(0, MAX_BODY_CHARS)}…` : line) : null,
    navTarget: { type: "chat", ...(meta.chatSessionId ? { sessionId: meta.chatSessionId } : {}) },
    payload: { runId, outputDir: meta.outputDir },
  });
  publish(item);
}

export interface ClaudeTaskStatus {
  runId: string;
  title: string;
  outputDir: string;
  status: string;
  summary: string | null;
  files: ClaudeTaskAnswer["files"];
  error: string | null;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/** A task's state, or null when the id names no task (or a run of another kind). */
export async function getClaudeTask(db: Db, runId: string): Promise<ClaudeTaskStatus | null> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.kind, CLAUDE_TASK_RUN_KIND)))
    .limit(1);
  if (!row) return null;
  const meta = row.meta as Partial<ClaudeTaskMeta>;
  const answer = answerSchema.safeParse(row.result);
  return {
    runId: row.id,
    title: meta.title ?? "",
    outputDir: meta.outputDir ?? row.targetKey,
    status: row.status,
    summary: answer.success ? answer.data.summary : null,
    files: answer.success ? answer.data.files : [],
    error: row.error,
    costUsd: row.costUsd,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
