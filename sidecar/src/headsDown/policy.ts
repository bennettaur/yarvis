import { and, eq, inArray } from "drizzle-orm";
import {
  ALWAYS_CONFIRM_BUILTIN_TOOLS,
  DESTRUCTIVE_BUILTIN_TOOLS,
} from "../chat/destructiveTools.ts";
import type { Db } from "../db/client.ts";
import { type HeadsDownRun, workStreamLinks, workStreams, workspaces } from "../db/schema.ts";
import { resolveApproval } from "../mcp/approvals.ts";
import type { ApprovalHooks } from "../mcp/chatTools.ts";
import { OPEN_STREAM_STATUSES, refKeyOf } from "../workStreams/service.ts";
import { getRepo } from "../workspaces/service.ts";
import { getHeadsDownConfig } from "./config.ts";
import { askQuestion, deniedApprovalExists, spendApproval } from "./service.ts";

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

const DENIED =
  "Not run: the user denied this exact call. Don't call it again; find another way or ask them with ask_user.";

/** How long an approval can still be spent. */
const APPROVAL_TTL_MS = 24 * 60 * 60_000;

/** At most this much of an approval's arguments goes into its question, and so into memory. */
const MAX_ARGS_IN_SITUATION = 500;

function stringArg(args: unknown, key: string): string | null {
  const value = (args as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : null;
}

/** Whether something is linked, by a chat turn, to a stream that is still open. */
async function chatLinkedToOpenStream(db: Db, refKey: string): Promise<boolean> {
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
 * or one created since this run started that a pass linked, which is a
 * workspace the pass started itself.
 */
async function isPushedWorkspace(db: Db, run: HeadsDownRun, workspaceId: string): Promise<boolean> {
  const refKey = refKeyOf({ kind: "workspace", workspaceId });
  if (await chatLinkedToOpenStream(db, refKey)) return true;
  const [workspace] = await db
    .select({ createdAt: workspaces.createdAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace || workspace.createdAt < run.startedAt) return false;
  const [link] = await db
    .select({ id: workStreamLinks.id })
    .from(workStreamLinks)
    .where(eq(workStreamLinks.refKey, refKey))
    .limit(1);
  return link !== undefined;
}

/**
 * Starting work the user planned: a ticket a chat turn linked to an open
 * stream, or a session on one of the user's own tasks. A ticket the pass
 * found or filed from a message waits for approval, and so does a free-form
 * brief, because either becomes an agent session's instructions.
 */
async function startsPlannedWork(db: Db, tool: string, args: unknown): Promise<boolean> {
  if (tool === "jira_start_work_on_issue") {
    const key = stringArg(args, "key");
    if (!key) return false;
    return chatLinkedToOpenStream(db, refKeyOf({ kind: "ticket", provider: "jira", key }));
  }
  if (tool === "start_work_on_issue") {
    const repoId = stringArg(args, "repoId");
    const issueNumber = (args as { issueNumber?: unknown } | null)?.issueNumber;
    if (!repoId || typeof issueNumber !== "number") return false;
    const repo = await getRepo(db, repoId);
    if (!repo) return false;
    const key = `${repo.owner}/${repo.repo}#${issueNumber}`;
    return chatLinkedToOpenStream(db, refKeyOf({ kind: "ticket", provider: "github", key }));
  }
  if (tool === "create_workspace_session") {
    return stringArg(args, "taskId") !== null && stringArg(args, "brief") === null;
  }
  return false;
}

export type CallDecision = "run" | "ask" | "refuse" | "denied";

/** Whether a pass may make this call now. `tool` is a built-in's name or an MCP tool's registry id. */
export async function decideCall(
  db: Db,
  run: HeadsDownRun,
  tool: string,
  args: unknown,
): Promise<CallDecision> {
  if (PASS_REFUSED_TOOLS.has(tool)) return "refuse";
  if (FILING_TOOLS.has(tool)) return "run";
  if (await startsPlannedWork(db, tool, args)) return "run";
  if (WORKSPACE_TOOLS.has(tool)) {
    const workspaceId = stringArg(args, "workspaceId");
    if (workspaceId && (await isPushedWorkspace(db, run, workspaceId))) return "run";
  }
  if ((await getHeadsDownConfig()).unattendedMcpTools.includes(tool)) return "run";
  // Grants are good for this run only, and for a day: what was approved may not hold later.
  const since = new Date(Math.max(run.startedAt.getTime(), Date.now() - APPROVAL_TTL_MS));
  if (await spendApproval(db, tool, args, since)) return "run";
  if (await deniedApprovalExists(db, tool, args, run.startedAt)) return "denied";
  return "ask";
}

/**
 * Approval hooks for a pass: each call is decided at once, and one that needs
 * the user becomes a question for them instead of a prompt to wait on.
 */
export function passApprovalHooks(db: Db, run: HeadsDownRun, onQueued: () => void): ApprovalHooks {
  return {
    deniedMessage: QUEUED_FOR_APPROVAL,
    onRequest: async ({ toolCallId, id, args }) => {
      let approved = false;
      try {
        const decision = await decideCall(db, run, id, args);
        approved = decision === "run";
        if (decision === "refuse") return { deniedMessage: REFUSED };
        if (decision === "denied") return { deniedMessage: DENIED };
        if (decision === "ask") {
          await askQuestion(db, {
            kind: "approval",
            question: `Heads-down mode wants to run ${id}.`,
            situation: `A heads-down pass called ${id} with ${JSON.stringify(args).slice(0, MAX_ARGS_IN_SITUATION)}`,
            action: id,
            toolArgs: args,
            options: ["approve", "deny"],
          });
          onQueued();
        }
        return undefined;
      } catch (e) {
        console.error("[heads-down] deciding a call failed:", e instanceof Error ? e.message : e);
        return { deniedMessage: "Not run: deciding whether it was allowed failed. Move on." };
      } finally {
        // Decided before the wrapper starts waiting; the registry keeps an
        // early decision for it, and a failure above still settles the call.
        resolveApproval(toolCallId, approved);
      }
    },
  };
}
