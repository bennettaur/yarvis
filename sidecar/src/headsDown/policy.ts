import { and, eq, inArray } from "drizzle-orm";
import {
  ALWAYS_CONFIRM_BUILTIN_TOOLS,
  DESTRUCTIVE_BUILTIN_TOOLS,
} from "../chat/destructiveTools.ts";
import type { Db } from "../db/client.ts";
import { type HeadsDownRun, issueLinks, workStreamLinks, workStreams } from "../db/schema.ts";
import { resolveApproval } from "../mcp/approvals.ts";
import type { ApprovalHooks } from "../mcp/chatTools.ts";
import { OPEN_STREAM_STATUSES, refKeyOf } from "../workStreams/service.ts";
import { getRepo } from "../workspaces/service.ts";
import { announceMerge, askUser, mergeKey } from "./attention.ts";
import {
  approvalQuestion,
  approvalSituation,
  autoApproveReason,
  type PassReviewContext,
} from "./autoApprove.ts";
import {
  deniedApprovalExists,
  getActiveRun,
  isToolUnattended,
  recordAutoApproval,
  spendApproval,
} from "./service.ts";

/**
 * What a heads-down pass may do with nobody watching.
 *
 * Every built-in that would need the user's go-ahead on some turn goes through
 * `decideCall`, and so does every MCP tool. A call the user hasn't allowed is
 * not run: it becomes an approval question on the Heads down page, the pass
 * moves on, and once the user approves, the same call runs on a later pass.
 * Nothing ever waits for the user.
 *
 * What the user allowed is decided from state a pass can't write. A pass reads
 * tickets, messages and recaps that anyone can author, so "this workspace is
 * linked to a stream" only counts when a chat turn made the link, never when
 * the pass did.
 */

/**
 * Tools a pass never runs, so asking the user about them would be noise.
 * Answers are recorded by the page; heads-down mode doesn't start or stop
 * itself; and memory is kept out of reach of a turn that spends its time
 * reading other people's text, since a planted "fact" would outlive the pass.
 */
export const PASS_REFUSED_TOOLS: ReadonlySet<string> = new Set([
  "record_decision",
  "start_heads_down",
  "stop_heads_down",
  "remember",
  "correct_memory",
  "confirm_memory",
  "take_note",
]);

/** The built-ins a pass routes through `decideCall` rather than running directly. */
export const PASS_CONFIRMED_TOOLS: ReadonlySet<string> = new Set([
  ...ALWAYS_CONFIRM_BUILTIN_TOOLS,
  ...DESTRUCTIVE_BUILTIN_TOOLS,
  ...PASS_REFUSED_TOOLS,
]);

/**
 * Filing a ticket lands in the user's own tracker, where they see it. Starting
 * work is narrower, see `startsPlannedWork`.
 */
const FILING_TOOLS: ReadonlySet<string> = new Set(["jira_create_issue"]);

/** Tools that act on one workspace's session. Fine on a workspace the loop is pushing. */
const WORKSPACE_TOOLS: ReadonlySet<string> = new Set([
  "send_workspace_instruction",
  "start_workspace_session",
]);

/** What a pass is told when a call is waiting on the user. */
export const QUEUED_FOR_APPROVAL =
  "Not run: this needs the user's approval, and is now waiting for them on the Heads down page. Move on to other work. If they approve, the approval and its exact arguments show in a later pass's prompt: call it again with those arguments.";

const REFUSED = "Not available in heads-down mode. Don't call it again in this pass.";

const DECIDING_FAILED = "Not run: deciding whether it was allowed failed. Move on.";

const STOPPED = "Not run: the user stopped heads-down mode. End the pass now with finish_pass.";

const DENIED =
  "Not run: the user denied this exact call. Don't call it again; find another way or ask them with ask_user.";

/** How long an approval can still be spent. */
const APPROVAL_TTL_MS = 24 * 60 * 60_000;

function stringArg(args: unknown, key: string): string | null {
  const value = (args as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : null;
}

function numberArg(args: unknown, key: string): number | null {
  const value = (args as Record<string, unknown> | null)?.[key];
  return typeof value === "number" ? value : null;
}

/** Whether something is linked, by a chat turn, to a stream that is still open. */
async function isChatLinkedToOpenStream(db: Db, refKey: string): Promise<boolean> {
  const rows = await db
    .select({ id: workStreamLinks.id })
    .from(workStreamLinks)
    .innerJoin(workStreams, eq(workStreams.id, workStreamLinks.streamId))
    .where(
      and(
        eq(workStreamLinks.refKey, refKey),
        eq(workStreamLinks.createdBy, "chat"),
        inArray(workStreams.status, [...OPEN_STREAM_STATUSES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * A workspace the loop is pushing: one a chat turn linked to an open stream,
 * or one that start-work opened for a ticket a chat turn linked to an open
 * stream. Start-work records which ticket it opened a workspace for, and a
 * pass can't write that record, so it can't pass off a workspace the user
 * started as one of its own.
 */
async function isPushedWorkspace(db: Db, workspaceId: string): Promise<boolean> {
  if (await isChatLinkedToOpenStream(db, refKeyOf({ kind: "workspace", workspaceId }))) {
    return true;
  }
  const tickets = await db
    .select({
      provider: issueLinks.provider,
      sourceKey: issueLinks.sourceKey,
      externalId: issueLinks.externalId,
    })
    .from(issueLinks)
    .where(eq(issueLinks.workspaceId, workspaceId));
  for (const ticket of tickets) {
    const key =
      ticket.provider === "github" ? `${ticket.sourceKey}#${ticket.externalId}` : ticket.externalId;
    const provider =
      ticket.provider === "azure" ? "azure-boards" : (ticket.provider as "github" | "jira");
    if (await isChatLinkedToOpenStream(db, refKeyOf({ kind: "ticket", provider, key }))) {
      return true;
    }
  }
  return false;
}

/**
 * Starting work the user planned: a ticket a chat turn linked to an open
 * stream. A ticket the pass found or filed from a message waits for approval,
 * because its text becomes an agent session's instructions. So does every new
 * session: its brief or task is text the pass chose, and a task is one it can
 * edit.
 */
async function startsPlannedWork(db: Db, tool: string, args: unknown): Promise<boolean> {
  if (tool === "jira_start_work_on_issue") {
    const key = stringArg(args, "key");
    if (!key) return false;
    return isChatLinkedToOpenStream(db, refKeyOf({ kind: "ticket", provider: "jira", key }));
  }
  if (tool === "start_work_on_issue") {
    const repoId = stringArg(args, "repoId");
    const issueNumber = numberArg(args, "issueNumber");
    if (!repoId || issueNumber === null) return false;
    const repo = await getRepo(db, repoId);
    if (!repo) return false;
    const key = `${repo.owner}/${repo.repo}#${issueNumber}`;
    return isChatLinkedToOpenStream(db, refKeyOf({ kind: "ticket", provider: "github", key }));
  }
  return false;
}

export type CallDecision = "run" | "ask" | "refuse" | "denied" | "stopped";

/** Whether a pass may make this call now. `tool` is a built-in's name or an MCP tool's registry id. */
export async function decideCall(
  db: Db,
  run: HeadsDownRun,
  tool: string,
  args: unknown,
): Promise<CallDecision> {
  if (PASS_REFUSED_TOOLS.has(tool)) return "refuse";
  // Stopped here or on another instance: nothing more runs, whatever the pass is still doing.
  if ((await getActiveRun(db))?.id !== run.id) return "stopped";
  if (FILING_TOOLS.has(tool)) return "run";
  if (await startsPlannedWork(db, tool, args)) return "run";
  if (WORKSPACE_TOOLS.has(tool)) {
    const workspaceId = stringArg(args, "workspaceId");
    if (workspaceId && (await isPushedWorkspace(db, workspaceId))) return "run";
  }
  if (tool.startsWith("mcp:") && (await isToolUnattended(db, tool))) return "run";
  // Grants are good for this run only, and for a day: what was approved may not hold later.
  const since = new Date(Math.max(run.startedAt.getTime(), Date.now() - APPROVAL_TTL_MS));
  if (await spendApproval(db, tool, args, since)) return "run";
  if (await deniedApprovalExists(db, tool, args, run.startedAt)) return "denied";
  return "ask";
}

/** Argument names MCP tools use for a PR's number. */
const PR_NUMBER_ARGS = ["pullNumber", "pull_number", "prNumber", "pr_number", "number", "pr"];

const PR_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

/**
 * The PR an MCP call merges, when it looks like a merge: a tool named like
 * `merge_pull_request` with a PR number or URL in its arguments. `repo` is
 * empty when the arguments don't name one.
 */
export function mergeCallTarget(
  tool: string,
  args: unknown,
): { repo: string; number: number } | null {
  if (!tool.startsWith("mcp:")) return null;
  const name = tool.slice(tool.lastIndexOf(":") + 1);
  // "merge_pull_request" merges; "get_mergeability" only asks about it.
  if (!/merge/i.test(name) || /mergeab/i.test(name)) return null;

  for (const key of ["url", "prUrl", "pr_url", "pullRequestUrl"]) {
    const match = stringArg(args, key)?.match(PR_URL);
    if (match) return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
  }
  let number: number | null = null;
  for (const key of PR_NUMBER_ARGS) {
    const value = numberArg(args, key) ?? Number(stringArg(args, key) ?? Number.NaN);
    if (Number.isInteger(value) && value > 0) {
      number = value;
      break;
    }
  }
  if (number === null) return null;
  const owner = stringArg(args, "owner");
  const repo = stringArg(args, "repo") ?? stringArg(args, "repository");
  if (owner && repo) return { repo: `${owner}/${repo}`, number };
  return { repo: repo?.includes("/") ? repo : "", number };
}

/** Raises the merge alert for a merge call the pass didn't announce first. */
async function alertUnannouncedMerge(
  db: Db,
  tool: string,
  args: unknown,
  announcedMerges: Set<string>,
): Promise<void> {
  const target = mergeCallTarget(tool, args);
  if (!target) return;
  const key = mergeKey(target.repo, target.number);
  if (announcedMerges.has(key)) return;
  announcedMerges.add(key);
  await announceMerge(db, {
    ...target,
    risk: "unknown",
    why: `Merged with ${tool} without announcing it first, so it didn't say how risky it is.`,
  });
}

/**
 * Approval hooks for a pass: each call is decided at once, and one that needs
 * the user becomes a question for them instead of a prompt to wait on, unless
 * the decision model may settle it (`autoApprove.ts`). `review` is absent when
 * the user said nothing this run to judge a call against. A merge call that
 * runs without the pass having announced it (`announcedMerges`) still raises
 * the merge alert.
 */
export function passApprovalHooks(
  db: Db,
  run: HeadsDownRun,
  onChanged: () => void,
  review?: PassReviewContext,
  announcedMerges: Set<string> = new Set(),
): ApprovalHooks {
  return {
    deniedMessage: QUEUED_FOR_APPROVAL,
    onRequest: async ({ toolCallId, id, args, description, messages }) => {
      let approved = false;
      try {
        const decision = await decideCall(db, run, id, args);
        approved = decision === "run";
        if (decision === "refuse") return { deniedMessage: REFUSED };
        if (decision === "denied") return { deniedMessage: DENIED };
        if (decision === "stopped") return { deniedMessage: STOPPED };
        if (decision !== "ask") return undefined;
        const question = approvalQuestion(id);
        const situation = approvalSituation(id, args);
        // A failed review is a no, never a reason to drop the question.
        const reason = review
          ? await autoApproveReason(review, { tool: id, args, description, messages }).catch(
              (e) => {
                console.error(
                  "[heads-down] auto approval failed:",
                  e instanceof Error ? e.message : e,
                );
                return null;
              },
            )
          : null;
        let autoApproved = false;
        if (reason !== null) {
          await recordAutoApproval(db, { action: id, args, question, situation, reason });
          autoApproved = true;
        } else {
          await askUser(db, {
            kind: "approval",
            question,
            situation,
            action: id,
            toolArgs: args,
            options: ["approve", "deny"],
          });
        }
        onChanged();
        // Set last, so a failure above can't settle the call as approved.
        approved = autoApproved;
        return undefined;
      } catch (e) {
        console.error("[heads-down] deciding a call failed:", e instanceof Error ? e.message : e);
        return { deniedMessage: DECIDING_FAILED };
      } finally {
        // Decided before the wrapper starts waiting; the registry keeps an
        // early decision for it, and a failure above still settles the call.
        resolveApproval(toolCallId, approved);
        if (approved) {
          await alertUnannouncedMerge(db, id, args, announcedMerges).catch((e) =>
            console.error("[heads-down] merge alert failed:", e instanceof Error ? e.message : e),
          );
        }
      }
    },
  };
}
