import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { DEFAULT_DECISION_MODEL_CONFIG } from "../llm/decision.ts";
import { waitForApproval } from "../mcp/approvals.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import {
  approvalQuestion,
  approvalSituation,
  autoApproveReason,
  type PassReviewContext,
  type ReviewDeps,
  userApprovedBefore,
} from "./autoApprove.ts";
import { passApprovalHooks } from "./policy.ts";
import {
  answeredSince,
  answerQuestion,
  askQuestion,
  lastUserActivityAt,
  listAutoApprovals,
  startRun,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const memory = new PgVectorMemoryStore(db, new HashEmbedder());
const config = { secrets: {} } as unknown as Config;

const TOOL = "mcp:slack:post_message";
const args = { channel: "#billing-reviews", text: "Could someone review acme/api#12?" };
/** A call like `args`, for another PR: approving it isn't a grant for `args` itself. */
const similarArgs = { channel: "#billing-reviews", text: "Could someone review acme/api#11?" };

/** The user answering an approval for `tool` with `args` on the page. */
async function userAnswers(choice: "approve" | "deny", callArgs: unknown = args, tool = TOOL) {
  const question = await askQuestion(db, {
    kind: "approval",
    question: approvalQuestion(tool),
    situation: approvalSituation(tool, callArgs),
    action: tool,
    toolArgs: callArgs,
  });
  await answerQuestion(db, memory, question.id, { choice });
}

/** Decision model calls that never touch a network; `approves` is its verdict. */
function deps(approves: boolean, calls: string[] = []): ReviewDeps {
  return {
    settings: async () => ({ ...DEFAULT_DECISION_MODEL_CONFIG, autoApproveHeadsDown: true }),
    resolveModel: async () => ({ provider: "custom:local", model: "jev" }),
    review: async (_config, _selection, call) => {
      calls.push(call.id);
      return { approved: approves, reason: approves ? "posts the review request asked for" : "no" };
    },
  };
}

function context(reviewDeps: ReviewDeps): PassReviewContext {
  return { config, memory, userRequest: "Ship the billing PR", deps: reviewDeps };
}

beforeEach(async () => {
  await sql`TRUNCATE heads_down_runs, heads_down_questions, attention_items, memories, events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("userApprovedBefore", () => {
  it("counts the user's approval of the same call", async () => {
    await userAnswers("approve");
    expect(await userApprovedBefore(memory, TOOL, args)).toBe(true);
  });

  it("doesn't count an approval of a different tool", async () => {
    await userAnswers("approve", args, "mcp:slack:delete_message");
    expect(await userApprovedBefore(memory, TOOL, args)).toBe(false);
  });

  it("follows the user's latest answer to the same call", async () => {
    await userAnswers("approve");
    await userAnswers("deny");
    expect(await userApprovedBefore(memory, TOOL, args)).toBe(false);
  });
});

describe("autoApproveReason", () => {
  it("approves an MCP call the user approved before, when the decision model agrees", async () => {
    await userAnswers("approve");
    const reason = await autoApproveReason(context(deps(true)), { tool: TOOL, args });
    expect(reason).toBe("posts the review request asked for");
  });

  it("asks the user when the decision model doesn't agree", async () => {
    await userAnswers("approve");
    expect(await autoApproveReason(context(deps(false)), { tool: TOOL, args })).toBeNull();
  });

  it("doesn't ask the decision model without a precedent", async () => {
    const calls: string[] = [];
    expect(await autoApproveReason(context(deps(true, calls)), { tool: TOOL, args })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("never settles a built-in, whose answer must come from the user", async () => {
    await userAnswers("approve", { workspaceId: "w1" }, "archive_workspace");
    const reason = await autoApproveReason(context(deps(true)), {
      tool: "archive_workspace",
      args: { workspaceId: "w1" },
    });
    expect(reason).toBeNull();
  });

  it("does nothing while auto mode for heads-down is off", async () => {
    await userAnswers("approve");
    const off: ReviewDeps = { ...deps(true), settings: async () => DEFAULT_DECISION_MODEL_CONFIG };
    expect(await autoApproveReason(context(off), { tool: TOOL, args })).toBeNull();
  });
});

describe("a pass's approval hooks with auto mode", () => {
  it("runs the call, lists it as approved on its own, and doesn't make it a precedent", async () => {
    const run = await startRun(db, "Ship the billing PR");
    await userAnswers("approve", similarArgs);
    const precedentsBefore = await memory.count({ kinds: ["decision"] });
    const hooks = passApprovalHooks(db, run, () => {}, context(deps(true)));

    await hooks.onRequest({ toolCallId: "auto-1", id: TOOL, args });

    expect(await waitForApproval("auto-1", { timeoutMs: 1000 })).toBe(true);
    const [approval] = await listAutoApprovals(db);
    expect(approval).toMatchObject({
      action: TOOL,
      answeredBy: "decision-model",
      answer: "posts the review request asked for",
    });
    expect(approval?.usedAt).not.toBeNull();
    expect(await memory.count({ kinds: ["decision"] })).toBe(precedentsBefore);
  });

  it("keeps the decision model's approvals out of the user's answers and activity", async () => {
    const run = await startRun(db, null);
    await sql`UPDATE heads_down_runs SET started_at = now() - interval '1 hour'`;
    await userAnswers("approve", similarArgs);
    const userAnswerAt = (await answeredSince(db, new Date(0)))[0]!.answeredAt!;
    const hooks = passApprovalHooks(db, run, () => {}, context(deps(true)));
    await hooks.onRequest({ toolCallId: "auto-2", id: TOOL, args });
    await waitForApproval("auto-2", { timeoutMs: 1000 });

    expect((await answeredSince(db, new Date(0))).map((q) => q.answeredBy)).toEqual(["user"]);
    const activity = await lastUserActivityAt(db, { ...run, startedAt: new Date(0) });
    expect(activity.getTime()).toBe(userAnswerAt.getTime());
  });
});
