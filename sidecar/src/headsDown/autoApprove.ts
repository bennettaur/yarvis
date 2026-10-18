import type { ModelMessage } from "ai";
import { reviewToolCall } from "../chat/toolReview.ts";
import type { Config } from "../config.ts";
import { getDecisionModelConfig, resolveDecisionModel } from "../llm/decision.ts";
import {
  decisionQuery,
  normalizeChoice,
  type Precedent,
  readDecision,
  weighPrecedents,
} from "../memory/decisions.ts";
import type { MemoryService } from "../memory/index.ts";

/**
 * When the decision model may approve an MCP call a heads-down pass would
 * otherwise queue for the user. Two things have to agree:
 *
 * - The user's own answers: they approved this tool in the same situation, or
 *   in several related ones with no denial, so it is a call they have shown
 *   they make. Only the user's answers are decision memories; an approval
 *   made here is recorded on the page but never becomes one, so the loop
 *   can't build up consent from its own approvals.
 * - The decision model: judged against the user's own words for this run, the
 *   call fits and is neither risky nor destructive.
 *
 * Only MCP tools, as with chat auto mode: a built-in that asks is one whose
 * answer must come from the user.
 */

/** How many of the closest decisions are weighed. */
const PRECEDENT_CANDIDATES = 20;

/** The question an approval asks, shared so a call can be matched to past answers. */
export function approvalQuestion(tool: string): string {
  return `Heads-down mode wants to run ${tool}.`;
}

/** At most this much of an approval's arguments goes into its question, and so into memory. */
const MAX_ARGS_IN_SITUATION = 500;

export function approvalSituation(tool: string, args: unknown): string {
  return `A heads-down pass called ${tool} with ${JSON.stringify(args ?? null).slice(0, MAX_ARGS_IN_SITUATION)}`;
}

/** Whether the user's past answers say they approve this tool in a situation like this one. */
export async function userApprovedBefore(
  memory: MemoryService,
  tool: string,
  args: unknown,
): Promise<boolean> {
  const hits = await memory.search(
    decisionQuery(approvalSituation(tool, args), approvalQuestion(tool)),
    PRECEDENT_CANDIDATES,
    { kinds: ["decision"], exact: true },
  );
  const precedents: Precedent[] = [];
  for (const hit of hits) {
    const detail = readDecision(hit);
    if (!detail || hit.validity !== "current") continue;
    precedents.push({
      id: hit.id,
      choice: detail.choice,
      action: detail.action,
      similarity: hit.similarity ?? 0,
      createdAt: hit.createdAt,
    });
  }
  const verdict = weighPrecedents(precedents, tool);
  return verdict.verdict === "decide" && normalizeChoice(verdict.choice) === "approve";
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
  memory: MemoryService;
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
  if (!(await userApprovedBefore(ctx.memory, call.tool, call.args))) return null;
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
