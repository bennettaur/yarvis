/**
 * The kick-off brief: the one file a workspace's first agent session is
 * launched to read, whatever produced the work — a GitHub issue, a JIRA ticket,
 * a Yarvis task, or a brief the chat agent composed. Keeping the path, the
 * document framing and the tool-result shape here is what lets one fixed launch
 * instruction serve every producer.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Db } from "../db/client.ts";
import { buildTaskBrief, getTask } from "../tasks/service.ts";
import { sessionStartedMessage } from "./claudeSession.ts";
import type { WorkspaceDetail } from "./service.ts";

/** Path of the brief, relative to the workspace root. */
export const WORKSPACE_BRIEF_FILE = ".yarvis/brief.md";

/**
 * Writes the brief into the workspace's `.yarvis/` folder (under the workspace
 * root, outside any repo worktree so it never dirties git status) and returns
 * the absolute path. The agent session is launched to read this file.
 */
export async function writeWorkspaceBrief(rootPath: string, brief: string): Promise<string> {
  const file = join(rootPath, WORKSPACE_BRIEF_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, brief, "utf8");
  return file;
}

/**
 * Frames free-text work — a brief the chat agent composed, with no ticket or
 * task behind it — as a brief document. Opens with an imperative line like
 * `buildIssuePrompt` and `buildTaskBrief` do, naming the workspace since there
 * is no ticket title to head the document with.
 */
export function buildBriefDocument(workspaceName: string, brief: string): string {
  return `Work on the following in the "${workspaceName}" workspace.\n\n${brief.trim()}\n`;
}

/**
 * Shapes the tool result for a workspace whose session provisioning already
 * launched on a brief. The brief is dropped once the session has been launched
 * on it, so a brief still sitting on the row is a launch that didn't happen.
 *
 * The session key is derived rather than taken from the starter: the launch
 * happened inside provisioning, which reports the outcome on the row and not to
 * the caller. It is the same key provisioning spawned under.
 */
export function kickOffResult(detail: WorkspaceDetail, remoteControl: boolean) {
  if (detail.pendingBrief) {
    return {
      error: "workspace is ready, but the agent session failed to start",
      workspaceId: detail.id,
      name: detail.name,
      status: detail.status,
      note: `Open the workspace locally and start the agent there; the work is already seeded in ${WORKSPACE_BRIEF_FILE}.`,
    };
  }
  return {
    workspaceId: detail.id,
    name: detail.name,
    status: detail.status,
    repos: detail.repos.map((r) => r.repo.name),
    sessionName: detail.name,
    sessionKey: `ws-claude:${detail.id}`,
    message: sessionStartedMessage(detail.name, remoteControl),
    briefFile: WORKSPACE_BRIEF_FILE,
  };
}

export interface ResolveBriefInput {
  /** Workspace name, which heads a brief that has no task or ticket behind it. */
  workspaceName: string;
  /** Task to work from, if any. Its title and notes become the brief. */
  taskId?: string | null;
  /** Free text to work from, on its own or as extra context beside a task. */
  brief?: string | null;
  /**
   * Whether a linked task should start the session working. False links the
   * task and leaves the session at an empty prompt for the user to drive — the
   * New Workspace form's "create" button, as against its "start work" one.
   * A `brief` is worked on either way: text written to be worked on has no
   * other purpose.
   */
  startWork: boolean;
}

/**
 * Works out what a new workspace's first session should be told to do, for
 * every caller that creates one — the chat agent's tools and the create route
 * alike, so the document a task produces doesn't depend on who asked. A null
 * brief means no kick-off: the session opens at a bare prompt.
 *
 * A `taskId` that resolves to nothing is an error rather than a fall-through.
 * The caller chose that id, the task also never gets linked (so the workspace
 * would never complete it on archive), and reporting work under way that nobody
 * described is worse than refusing.
 *
 * The text is sanitized on the way into the workspace row by `createWorkspace`,
 * since it ends up in front of an auto-approved agent.
 */
export async function resolveWorkspaceBrief(
  db: Db,
  input: ResolveBriefInput,
): Promise<{ brief: string | null } | { error: string }> {
  const free = input.brief?.trim() ? input.brief : null;
  if (input.taskId) {
    const task = await getTask(db, input.taskId);
    if (!task) return { error: "task not found; call list_tasks to get a valid id" };
    if (input.startWork) return { brief: buildTaskBrief(task, free) };
  }
  return { brief: free ? buildBriefDocument(input.workspaceName, free) : null };
}
