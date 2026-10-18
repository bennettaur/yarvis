import {
  ALWAYS_CONFIRM_BUILTIN_TOOLS,
  DESTRUCTIVE_BUILTIN_TOOLS,
} from "../chat/destructiveTools.ts";
import type { Db } from "../db/client.ts";
import { resolveApproval } from "../mcp/approvals.ts";
import type { ApprovalHooks } from "../mcp/chatTools.ts";
import { findStreamsLinkedTo, OPEN_STREAM_STATUSES } from "../workStreams/service.ts";
import { askQuestion, spendApproval } from "./service.ts";

/**
 * What a heads-down pass may do with nobody watching.
 *
 * Every built-in that would need the user's go-ahead on some turn goes through
 * `decideCall`, and so does every MCP tool without standing consent. A call
 * the user hasn't allowed is not run: it becomes an approval question on the
 * Heads down page, the pass moves on, and once the user approves, the same
 * call runs on a later pass. Nothing ever waits for the user.
 */

/** The built-ins a pass routes through `decideCall` rather than running directly. */

/**
 * What the user puts in heads-down mode's hands by turning it on: filing
 * tickets and starting work on them. Each lands in the user's own trackers
 * and workspaces, and the work it starts is visible there.
 */
export const UNATTENDED_TOOLS: ReadonlySet<string> = new Set([
  "start_work_on_issue",
  "jira_start_work_on_issue",
  "jira_create_issue",
  "create_workspace_session",
]);

/**
 * Tools that act on one workspace's session. Fine on a workspace the loop is
 * pushing, which is one linked to an open work stream; asked about otherwise,
 * since a session the user is driving themselves isn't the loop's to steer.
 */
export const WORKSPACE_TOOLS: ReadonlySet<string> = new Set([
  "send_workspace_instruction",
  "start_workspace_session",
]);

/**
 * Tools a pass never runs, so asking the user about them would be noise. A
 * pass's questions are answered on the page, which records the decision
 * itself; and heads-down mode doesn't start or stop itself.
 */
export const PASS_REFUSED_TOOLS: ReadonlySet<string> = new Set([
  "record_decision",
  "start_heads_down",
  "stop_heads_down",
]);

/** The built-ins a pass routes through `decideCall` rather than running directly. */
export const PASS_CONFIRMED_TOOLS: ReadonlySet<string> = new Set([
  ...ALWAYS_CONFIRM_BUILTIN_TOOLS,
  ...DESTRUCTIVE_BUILTIN_TOOLS,
  ...PASS_REFUSED_TOOLS,
]);

/** What a pass is told when a call is waiting on the user. */
export const QUEUED_FOR_APPROVAL =
  "Not run: this needs the user's approval, and is now waiting for them on the Heads down page. Move on to other work. Once they approve, call it again with exactly the same arguments on a later pass.";

async function isPushedWorkspace(db: Db, args: unknown): Promise<boolean> {
  const workspaceId = (args as { workspaceId?: unknown } | null)?.workspaceId;
  if (typeof workspaceId !== "string") return false;
  const streams = await findStreamsLinkedTo(db, { kind: "workspace", workspaceId });
  return streams.some((s) => (OPEN_STREAM_STATUSES as readonly string[]).includes(s.status));
}

/** Whether a pass may make this call now. `tool` is a built-in's name or an MCP tool's registry id. */
export async function decideCall(
  db: Db,
  tool: string,
  args: unknown,
): Promise<"run" | "ask" | "refuse"> {
  if (PASS_REFUSED_TOOLS.has(tool)) return "refuse";
  if (UNATTENDED_TOOLS.has(tool)) return "run";
  if (WORKSPACE_TOOLS.has(tool) && (await isPushedWorkspace(db, args))) return "run";
  if (await spendApproval(db, tool, args)) return "run";
  return "ask";
}

/**
 * Approval hooks for a pass: each call is decided at once, and one that needs
 * the user becomes a question for them instead of a prompt to wait on.
 */
export function passApprovalHooks(db: Db, onQueued: (questionId: string) => void): ApprovalHooks {
  return {
    deniedMessage: QUEUED_FOR_APPROVAL,
    onRequest: async ({ toolCallId, id, args }) => {
      let approved = false;
      try {
        const decision = await decideCall(db, id, args);
        approved = decision === "run";
        if (decision === "ask") {
          const question = await askQuestion(db, {
            kind: "approval",
            question: `Heads-down mode wants to run ${id}.`,
            situation: `A heads-down pass called ${id} with ${JSON.stringify(args)}`,
            action: id,
            toolArgs: args,
            options: ["approve", "deny"],
          });
          onQueued(question.id);
        }
      } finally {
        // Decided before the wrapper starts waiting; the registry keeps an
        // early decision for it, and a failure above still settles the call.
        resolveApproval(toolCallId, approved);
      }
    },
  };
}
