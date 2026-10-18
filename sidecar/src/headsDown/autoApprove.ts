import type { ModelMessage } from "ai";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { reviewToolCall } from "../chat/toolReview.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { headsDownQuestions } from "../db/schema.ts";
import { getDecisionModelConfig, resolveDecisionModel } from "../llm/decision.ts";
import { hashArgs } from "./service.ts";

/**
 * When the decision model may approve an MCP call a heads-down pass would
 * otherwise queue for the user. Two things have to agree:
 *
 * - The user's own answers to approvals of this tool on the Heads down page:
 *   they approved this exact call before, or their last few answers for the
 *   tool were all approvals. Read from the approval rows themselves, which
 *   only the page writes, rather than from decision memory, which a chat turn
 *   or a pass's own `ask_user` question can add to. An approval made here is
 *   recorded as the decision model's, so it never counts as the user's.
 * - The decision model: judged against the user's own words for this run, the
 *   call fits and is neither risky nor destructive.
 *
 * Only MCP tools, as with chat auto mode: a built-in that asks is one whose
 * answer must come from the user.
 */

/** The question an approval asks. */
export function approvalQuestion(tool: string): string {
  return `Heads-down mode wants to run ${tool}.`;
}

/** At most this much of an approval's arguments goes into its question, and so into memory. */
const MAX_ARGS_IN_SITUATION = 500;

export function approvalSituation(tool: string, args: unknown): string {
  return `A heads-down pass called ${tool} with ${JSON.stringify(args ?? null).slice(0, MAX_ARGS_IN_SITUATION)}`;
}

/**
 * How many of the user's latest answers for a tool must all be approvals. One
 * yes says little about the next call; several in a row with no no say the
 * user makes this call as a matter of course.
 */
export const CONSISTENT_APPROVALS = 3;

/** Answers older than this no longer speak for the user. */
const PRECEDENT_WINDOW_MS = 90 * 24 * 60 * 60_000;

/**
 * Whether the user's own approval answers say they make this call: their
 * newest answer for these exact arguments was an approval, or, with none, their
 * last few answers for the tool were all approvals. Any denial among those
 * answers is a no.
 */
export async function userApprovedBefore(db: Db, tool: string, args: unknown): Promise<boolean> {
  const since = new Date(Date.now() - PRECEDENT_WINDOW_MS);
  const answered = and(
    eq(headsDownQuestions.kind, "approval"),
    eq(headsDownQuestions.status, "answered"),
    eq(headsDownQuestions.action, tool),
    sql`${headsDownQuestions.answeredBy} is distinct from 'decision-model'`,
    gte(headsDownQuestions.answeredAt, since),
  );
  const [sameCall] = await db
    .select({ choice: headsDownQuestions.choice })
    .from(headsDownQuestions)
    .where(and(answered, eq(headsDownQuestions.argsHash, hashArgs(args ?? null))))
    .orderBy(desc(headsDownQuestions.answeredAt))
    .limit(1);
  if (sameCall) return sameCall.choice === "approve";
  const latest = await db
    .select({ choice: headsDownQuestions.choice })
    .from(headsDownQuestions)
    .where(answered)
    .orderBy(desc(headsDownQuestions.answeredAt))
    .limit(CONSISTENT_APPROVALS);
  return latest.length === CONSISTENT_APPROVALS && latest.every((a) => a.choice === "approve");
}

/** The decision model calls, replaceable so a test needs no model. */
export interface ReviewDeps {
  settings: typeof getDecisionModelConfig;
  resolveModel: typeof resolveDecisionModel;
  review: typeof reviewToolCall;
}

const DEFAULT_DEPS: ReviewDeps = {
  settings: getDecisionModelConfig,
  resolveModel: resolveDecisionModel,
  review: reviewToolCall,
};

/** What a pass gives the reviewer: the user's own words for this run. */
export interface PassReviewContext {
  config: Config;
  db: Db;
  /** The run's focus and the user's messages, which is what the user asked for. */
  userRequest: string;
  signal?: AbortSignal;
  deps?: ReviewDeps;
}

export interface AutoApproveCall {
  tool: string;
  args: unknown;
  description?: string;
  messages?: ModelMessage[];
}

/**
 * The decision model's reason when it may approve this call, or null when the
 * user must be asked: auto approval off, no usable decision model, no
 * precedent, or anything short of a clear yes.
 */
export async function autoApproveReason(
  ctx: PassReviewContext,
  call: AutoApproveCall,
): Promise<string | null> {
  if (!call.tool.startsWith("mcp:")) return null;
  const deps = ctx.deps ?? DEFAULT_DEPS;
  const settings = await deps.settings();
  if (!settings.autoApproveHeadsDown) return null;
  const selection = await deps.resolveModel(ctx.config, settings.model);
  if (!selection) return null;
  // Precedent first: it is a local query, and without it there is nothing to ask the model.
  if (!(await userApprovedBefore(ctx.db, call.tool, call.args))) return null;
  const outcome = await deps.review(
    ctx.config,
    selection,
    {
      id: call.tool,
      description: call.description,
      args: call.args,
      messages: call.messages ?? [],
      signal: ctx.signal,
    },
    ctx.userRequest,
  );
  return outcome.approved ? outcome.reason : null;
}
