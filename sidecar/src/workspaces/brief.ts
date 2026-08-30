/**
 * The kick-off brief: the one file a workspace's first agent session is
 * launched to read, whatever produced the work — a GitHub issue, a JIRA ticket,
 * a Yarvis task, or a brief the chat agent composed. Keeping the path, the
 * document framing and the tool-result shape here is what lets one fixed launch
 * instruction serve every producer.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
