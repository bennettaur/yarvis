import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunStatus } from "../agentRuns/events.ts";
import type { AgentRunOutcome, ClaudeRunDeps } from "../agentRuns/service.ts";
import { spotlight, startClaudeRun } from "../agentRuns/service.ts";
import { publish } from "../attention/hub.ts";
import { createAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type AttentionNavTarget, agentRuns } from "../db/schema.ts";
import { redactSecrets } from "../llm/errors.ts";

/**
 * Hands a self-contained piece of work — build a small website, write a brief,
 * draft a document — to a headless Claude Code run, without provisioning a
 * workspace. The run starts in a fresh, empty output folder and leaves its
 * files there; the user gets an attention item when it ends.
 *
 * It goes through `startClaudeRun`, so it has the same lockdown as the review
 * runs: no settings files, no MCP servers, no network, and a spend ceiling. On
 * top of that it can only read and write inside its own folder. The task text
 * is the chat model's own words, which may have been composed after reading a
 * ticket or a web page, so the run gets nothing it could publish with and
 * nothing of the user's it could gather up and hand back.
 */

export const CLAUDE_TASK_RUN_KIND = "claude-task";

export const MAX_TITLE_CHARS = 80;
export const MAX_TASK_CHARS = 20_000;
export const MAX_MATERIAL_CHARS = 100_000;

/** A task is a one-off piece of work, not a project: these cap a run that loses its way. */
const MAX_BUDGET_USD = 5;
const MAX_TURNS = 150;
export const MAX_RUN_MINUTES = 30;

/** Each run can spend up to the budget above, so a looping turn can't start them without bound. */
export const MAX_RUNNING_TASKS = 3;

/** Longest bell body; the full summary is one tool call away. */
const MAX_BODY_CHARS = 300;

/** What `get_claude_code_task` hands back, so one verbose run can't fill the chat's context. */
const MAX_SUMMARY_CHARS = 4_000;
const MAX_LISTED_FILES = 20;
const MAX_DESCRIPTION_CHARS = 300;

/**
 * The run gets the file tools and nothing else: no shell, since the sandbox
 * limits where Bash writes but lets it read almost anything, no network, and
 * no subagents, so the run's limits hold for everything it does. `restricted`
 * keeps every file tool inside the folder and refuses writes to settings and
 * tool-configuration files, which a later session opened there would load.
 * Writes come from `acceptEdits`, which approves them inside the folder.
 */
const TASK_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"];

/** How a task's run is launched, shared with `agentRuns/canary.ts` so it checks what ships. */
export function taskRunPolicy(outputDir: string) {
  return {
    cwd: outputDir,
    tools: TASK_TOOLS,
    // Already absent from the tool list; denied as well in case a Claude Code
    // build stops honouring it.
    disallowedTools: ["Bash", "WebFetch", "WebSearch", "NotebookEdit", "Agent", "Task"],
    restricted: true,
    permissionMode: "acceptEdits" as const,
    guardrail: "task" as const,
    // `//` marks an absolute path in a permission rule.
    allowedTools: [`Read(/${outputDir}/**)`, "TodoWrite"],
  };
}

const SYSTEM_PROMPT = [
  "The working directory starts empty: put everything you make there.",
  "You can only read and write inside it, you have no shell and no network access,",
  "so build with plain files: prefer a single HTML file with inline CSS and JavaScript",
  "for anything that should open in a browser, and Markdown for a document.",
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

/** A type alias rather than an interface, so it passes as the run's `meta` record. */
export type ClaudeTaskMeta = {
  title: string;
  /** The chat that started it, so the bell item can open it. Null off a chat turn. */
  chatSessionId: string | null;
  /** Started by a heads-down pass, whose chat is hidden: the bell opens the Heads down page. */
  headsDown: boolean;
};

export interface StartClaudeTaskInput {
  title: string;
  task: string;
  /** Text someone else wrote that the task works from: fenced, so the run reads it as data. */
  material?: string;
  chatSessionId: string | null;
  headsDown: boolean;
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
  // Counted before starting rather than locked: two turns racing past the
  // check start one run too many, which the per-run budget still bounds.
  const running = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.kind, CLAUDE_TASK_RUN_KIND), eq(agentRuns.status, "running")));
  if (running.length >= MAX_RUNNING_TASKS) {
    throw new Error(
      `${running.length} Claude Code tasks are already running; wait for one to finish`,
    );
  }

  const outputDir = join(claudeTasksRoot(config), randomUUID());
  mkdirSync(outputDir, { recursive: true });
  const meta: ClaudeTaskMeta = {
    title: input.title,
    chatSessionId: input.chatSessionId,
    headsDown: input.headsDown,
  };
  const prompt = input.material
    ? `${input.task}\n\n${spotlight("material", input.material)}`
    : input.task;
  try {
    const handle = await startClaudeRun(
      db,
      {
        kind: CLAUDE_TASK_RUN_KIND,
        ...taskRunPolicy(outputDir),
        targetKey: outputDir,
        prompt,
        outputSchema: answerSchema,
        finishOutput: (answer) => ({ ...answer, files: filesInFolder(outputDir, answer.files) }),
        appendSystemPrompt: SYSTEM_PROMPT,
        maxBudgetUsd: MAX_BUDGET_USD,
        maxTurns: MAX_TURNS,
        timeoutMs: MAX_RUN_MINUTES * 60 * 1000,
        meta,
      },
      deps,
    );
    void handle.done
      .then((outcome) => notifyFinished(db, handle.id, outputDir, meta, outcome))
      .catch((e) => console.error(`[claude-tasks] could not report the end of ${handle.id}:`, e));
    return { runId: handle.id, outputDir };
  } catch (e) {
    rmSync(outputDir, { recursive: true, force: true });
    throw e;
  }
}

function isInside(path: string, root: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
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
    return isInside(realpathSync(target), root);
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The bell body. It is model text and is shown in the bell and as an OS
 * notification, so it is kept to one redacted line. The title is ours, so
 * injected text can't pose as an app alert.
 */
function notificationBody(text: string | null | undefined): string | null {
  const oneLine = redactSecrets((text ?? "").replace(/\s+/g, " ").trim());
  return oneLine ? truncate(oneLine, MAX_BODY_CHARS) : null;
}

function navTargetFor(meta: ClaudeTaskMeta): AttentionNavTarget {
  if (meta.headsDown) return { type: "heads-down" };
  return meta.chatSessionId ? { type: "chat", sessionId: meta.chatSessionId } : { type: "chat" };
}

async function notifyFinished(
  db: Db,
  runId: string,
  outputDir: string,
  meta: ClaudeTaskMeta,
  outcome: AgentRunOutcome<ClaudeTaskAnswer>,
): Promise<void> {
  if (outcome.status === "cancelled") return;
  const succeeded = outcome.status === "succeeded";
  const item = await createAttention(db, {
    source: "chat-agent",
    sessionKey: `claude-task:${runId}`,
    kind: succeeded ? "info" : "error",
    title: succeeded
      ? `Claude Code finished: ${meta.title}`
      : `Claude Code task failed: ${meta.title}`,
    body: notificationBody(succeeded ? outcome.output?.summary : outcome.error),
    navTarget: navTargetFor(meta),
    payload: { runId, outputDir },
  });
  publish(item);
}

export interface ClaudeTaskStatus {
  runId: string;
  title: string;
  outputDir: string;
  status: AgentRunStatus;
  summary: string | null;
  files: ClaudeTaskAnswer["files"];
  error: string | null;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * A task's state, or null when the id names no task (or a run of another
 * kind). Text the run wrote is cut down to what a chat turn should carry.
 */
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
    outputDir: row.targetKey,
    status: row.status as AgentRunStatus,
    summary: answer.success ? truncate(answer.data.summary, MAX_SUMMARY_CHARS) : null,
    files: answer.success
      ? answer.data.files.slice(0, MAX_LISTED_FILES).map((file) => ({
          path: file.path,
          description: truncate(file.description, MAX_DESCRIPTION_CHARS),
        }))
      : [],
    error: row.error === null ? null : truncate(row.error, MAX_SUMMARY_CHARS),
    costUsd: row.costUsd,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
