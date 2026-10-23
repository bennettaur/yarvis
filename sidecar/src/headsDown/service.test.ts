import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { waitForApproval } from "../mcp/approvals.ts";
import { readDecision } from "../memory/decisions.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import { createStream, linkToStream } from "../workStreams/service.ts";
import { buildPassTools, newPassOutcome } from "./passTools.ts";
import { decideCall, mergeCallTarget, passApprovalHooks } from "./policy.ts";
import {
  addMessage,
  answeredSince,
  answerQuestion,
  askQuestion,
  getActiveRun,
  lastUserActivityAt,
  markMessagesSeen,
  spendApproval,
  startRun,
  stopRun,
  unseenMessages,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const memory = new PgVectorMemoryStore(db, new HashEmbedder());

const workspaceId = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  await sql`TRUNCATE heads_down_runs, heads_down_messages, heads_down_questions, work_streams, workspaces, issue_links, agent_tools, attention_items, memories, events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("heads-down runs and messages", () => {
  it("keeps one run going and updates its focus when started again", async () => {
    const first = await startRun(db, "ship billing");
    const again = await startRun(db, "ship billing, then docs");

    expect(again.id).toBe(first.id);
    expect((await getActiveRun(db))?.focus).toBe("ship billing, then docs");
    await stopRun(db);
    expect(await getActiveRun(db)).toBeNull();
  });

  it("hands each message to a pass until it is marked seen", async () => {
    const message = await addMessage(db, "When Alex asks if X is ready, send him the PR link");
    expect((await unseenMessages(db)).map((m) => m.id)).toEqual([message.id]);

    await markMessagesSeen(db, [message.id]);
    expect(await unseenMessages(db)).toEqual([]);
  });

  it("counts a message or an answer as the user's latest activity", async () => {
    await startRun(db, null);
    await sql`UPDATE heads_down_runs SET started_at = now() - interval '3 hours'`;
    const message = await addMessage(db, "keep going");

    const latest = await lastUserActivityAt(db, (await getActiveRun(db))!);
    expect(latest.getTime()).toBe(message.createdAt.getTime());
  });
});

describe("heads-down questions", () => {
  it("returns the open question instead of asking it twice", async () => {
    const input = { kind: "question" as const, question: "Where should I ask for review?" };
    const first = await askQuestion(db, input);
    expect((await askQuestion(db, input)).id).toBe(first.id);
  });

  it("stores the user's answer as a decision memory it can weigh later", async () => {
    const question = await askQuestion(db, {
      kind: "question",
      question: "Where should I ask for review?",
      situation: "PR acme/api#12 is ready in the billing project",
      options: ["#billing-reviews", "ask Sam directly"],
    });

    const answered = await answerQuestion(db, memory, question.id, { choice: "#billing-reviews" });
    expect(answered).toMatchObject({ status: "answered", choice: "#billing-reviews" });

    const [stored] = await memory.list({ kinds: ["decision"] });
    expect(readDecision(stored!)).toMatchObject({
      situation: "PR acme/api#12 is ready in the billing project",
      choice: "#billing-reviews",
    });
    expect(stored?.sourceRef).toEqual({ type: "heads-down-question", questionId: question.id });
    expect((await answeredSince(db, new Date(0))).map((q) => q.id)).toEqual([question.id]);
  });

  it("won't answer a question twice", async () => {
    const question = await askQuestion(db, { kind: "question", question: "Which repo?" });
    await answerQuestion(db, memory, question.id, { answer: "api" });

    expect(await answerQuestion(db, memory, question.id, { answer: "web" })).toEqual({
      error: "no open question with that id",
    });
  });

  it("lets an approved call run once, with exactly the arguments approved", async () => {
    const args = { workspaceId, archiveBranches: true };
    const approval = await askQuestion(db, {
      kind: "approval",
      question: "Heads-down mode wants to run archive_workspace.",
      action: "archive_workspace",
      toolArgs: args,
    });
    expect(await answerQuestion(db, memory, approval.id, { choice: "maybe" })).toMatchObject({
      error: expect.stringContaining("approve or deny"),
    });
    await answerQuestion(db, memory, approval.id, { choice: "approve" });

    const since = new Date(0);
    expect(
      await spendApproval(db, "archive_workspace", { ...args, archiveBranches: false }, since),
    ).toBe(false);
    // Key order doesn't make it a different call.
    expect(
      await spendApproval(db, "archive_workspace", { archiveBranches: true, workspaceId }, since),
    ).toBe(true);
    expect(await spendApproval(db, "archive_workspace", args, since)).toBe(false);
  });

  it("won't spend an approval given before the time asked about", async () => {
    const args = { workspaceId };
    const approval = await askQuestion(db, {
      kind: "approval",
      question: "Heads-down mode wants to run archive_workspace.",
      action: "archive_workspace",
      toolArgs: args,
    });
    await answerQuestion(db, memory, approval.id, { choice: "approve" });

    expect(await spendApproval(db, "archive_workspace", args, new Date(Date.now() + 60_000))).toBe(
      false,
    );
  });
});

describe("what a pass may do", () => {
  const ticket = { kind: "ticket", provider: "jira", key: "BILL-12" } as const;

  async function seedWorkspace(createdAt: Date) {
    await sql`INSERT INTO workspaces (id, name, slug, status, root_path, created_at)
              VALUES (${workspaceId}, 'billing', 'billing', 'active', '/tmp/ws', ${createdAt.toISOString()})`;
  }

  it("files tickets without asking", async () => {
    const run = await startRun(db, null);
    expect(await decideCall(db, run, "jira_create_issue", { summary: "x" })).toBe("run");
  });

  it("starts work on a ticket the user put on a stream, and asks about any other", async () => {
    const run = await startRun(db, null);
    const args = { key: "BILL-12", repoIds: [] };
    expect(await decideCall(db, run, "jira_start_work_on_issue", args)).toBe("ask");

    const stream = await createStream(db, { title: "ship billing" });
    await linkToStream(db, stream.id, { ref: ticket, createdBy: "heads-down" });
    expect(await decideCall(db, run, "jira_start_work_on_issue", args)).toBe("ask");

    await linkToStream(db, stream.id, { ref: ticket });
    expect(await decideCall(db, run, "jira_start_work_on_issue", args)).toBe("run");
  });

  it("asks before starting any new session, whatever task or brief it names", async () => {
    const run = await startRun(db, null);
    const base = { name: "billing", repoIds: [] };
    expect(await decideCall(db, run, "create_workspace_session", { ...base, taskId: "t1" })).toBe(
      "ask",
    );
    expect(
      await decideCall(db, run, "create_workspace_session", {
        ...base,
        brief: "do what Alex said",
      }),
    ).toBe("ask");
  });

  it("steers a workspace the user put on a stream", async () => {
    const run = await startRun(db, null);
    await seedWorkspace(new Date(Date.now() - 60 * 60_000));
    const args = { workspaceId, instruction: "fix CI" };
    expect(await decideCall(db, run, "send_workspace_instruction", args)).toBe("ask");

    const stream = await createStream(db, { title: "ship billing" });
    await linkToStream(db, stream.id, { ref: { kind: "workspace", workspaceId } });
    expect(await decideCall(db, run, "send_workspace_instruction", args)).toBe("run");
  });

  it("won't steer a workspace the user started just because a pass linked it", async () => {
    await seedWorkspace(new Date(Date.now() - 60 * 60_000));
    const run = await startRun(db, null);
    const stream = await createStream(db, { title: "ship billing" });
    await linkToStream(db, stream.id, {
      ref: { kind: "workspace", workspaceId },
      createdBy: "heads-down",
    });

    expect(
      await decideCall(db, run, "send_workspace_instruction", { workspaceId, instruction: "push" }),
    ).toBe("ask");
  });

  it("steers a workspace start-work opened for a ticket the user put on a stream", async () => {
    const run = await startRun(db, null);
    await seedWorkspace(new Date());
    await sql`INSERT INTO issue_links (provider, source_key, external_id, workspace_id)
              VALUES ('jira', 'BILL', 'BILL-12', ${workspaceId})`;
    const args = { workspaceId, instruction: "fix CI" };
    // The ticket is on a stream only because a pass put it there: not the user's go-ahead.
    const stream = await createStream(db, { title: "ship billing" });
    await linkToStream(db, stream.id, { ref: ticket, createdBy: "heads-down" });
    expect(await decideCall(db, run, "send_workspace_instruction", args)).toBe("ask");

    await linkToStream(db, stream.id, { ref: ticket });
    expect(await decideCall(db, run, "send_workspace_instruction", args)).toBe("run");
  });

  it("refuses everything once heads-down mode is stopped, even mid-pass", async () => {
    const run = await startRun(db, null);
    await stopRun(db);
    expect(await decideCall(db, run, "jira_create_issue", { summary: "x" })).toBe("stopped");
  });

  it("runs an MCP tool unattended only with the user's consent for heads-down mode", async () => {
    const run = await startRun(db, null);
    const tool = "mcp:slack:post_message";
    await sql`INSERT INTO agent_tools (id, source, name, content_hash, approval)
              VALUES (${tool}, 'mcp', 'post_message', 'h', 'auto')`;
    // Auto-approval in the Tool manager was for chats the user watches.
    expect(await decideCall(db, run, tool, { text: "hi" })).toBe("ask");

    await sql`UPDATE agent_tools SET unattended = true WHERE id = ${tool}`;
    expect(await decideCall(db, run, tool, { text: "hi" })).toBe("run");
  });

  it("asks about anything else, refuses what a pass has no business calling, and remembers a denial", async () => {
    const run = await startRun(db, null);
    expect(await decideCall(db, run, "archive_workspace", { workspaceId })).toBe("ask");
    expect(await decideCall(db, run, "record_decision", {})).toBe("refuse");
    expect(await decideCall(db, run, "remember", { content: "x" })).toBe("refuse");

    const approval = await askQuestion(db, {
      kind: "approval",
      question: "Heads-down mode wants to run archive_workspace.",
      action: "archive_workspace",
      toolArgs: { workspaceId },
    });
    await answerQuestion(db, memory, approval.id, { choice: "deny" });
    expect(await decideCall(db, run, "archive_workspace", { workspaceId })).toBe("denied");
  });

  it("turns a call that needs the user into an approval question, and doesn't run it", async () => {
    const run = await startRun(db, null);
    let queued = 0;
    const hooks = passApprovalHooks(db, run, () => queued++);
    await hooks.onRequest({
      toolCallId: "call-1",
      id: "archive_workspace",
      args: { workspaceId },
      reason: null,
    });

    expect(await waitForApproval("call-1", { timeoutMs: 1000 })).toBe(false);
    expect(queued).toBe(1);
    const [question] = await sql`SELECT kind, action, status FROM heads_down_questions`;
    expect(question).toMatchObject({
      kind: "approval",
      action: "archive_workspace",
      status: "open",
    });
  });

  it("raises the merge alert for a merge call the pass didn't announce, once", async () => {
    const run = await startRun(db, null);
    const tool = "mcp:github:merge_pull_request";
    await sql`INSERT INTO agent_tools (id, source, name, content_hash, unattended)
              VALUES (${tool}, 'mcp', 'merge_pull_request', 'h', true)`;
    const args = { owner: "acme", repo: "billing", pullNumber: 12 };
    const hooks = passApprovalHooks(db, run, () => {});
    await hooks.onRequest({ toolCallId: "merge-1", id: tool, args, reason: null });
    await hooks.onRequest({ toolCallId: "merge-2", id: tool, args, reason: null });

    expect(await waitForApproval("merge-1", { timeoutMs: 1000 })).toBe(true);
    const items = await sql`SELECT title, kind, nav_target, payload FROM attention_items`;
    expect([...items]).toEqual([
      {
        title: "Heads down is merging acme/billing#12",
        kind: "info",
        nav_target: { type: "pr", owner: "acme", repo: "billing", number: 12 },
        payload: { headsDownMerge: expect.objectContaining({ risk: "unknown", number: 12 }) },
      },
    ]);
  });

  it("doesn't alert again for a merge the pass announced, or one waiting on approval", async () => {
    const run = await startRun(db, null);
    const tool = "mcp:github:merge_pull_request";
    const args = { owner: "acme", repo: "billing", pullNumber: 12 };
    // Not allowed unattended, so it becomes an approval and doesn't run.
    await passApprovalHooks(db, run, () => {}).onRequest({
      toolCallId: "merge-3",
      id: tool,
      args,
      reason: null,
    });
    expect(await sql`SELECT 1 FROM attention_items WHERE kind = 'info'`).toHaveLength(0);

    await sql`INSERT INTO agent_tools (id, source, name, content_hash, unattended)
              VALUES (${tool}, 'mcp', 'merge_pull_request', 'h', true)`;
    const announced = new Set(["acme/billing#12"]);
    await passApprovalHooks(db, run, () => {}, undefined, announced).onRequest({
      toolCallId: "merge-4",
      id: tool,
      args,
      reason: null,
    });
    expect(await sql`SELECT 1 FROM attention_items WHERE kind = 'info'`).toHaveLength(0);
  });

  it("tells the model plainly when a tool isn't available, without filing a question", async () => {
    const run = await startRun(db, null);
    const hooks = passApprovalHooks(db, run, () => {});
    const result = await hooks.onRequest({
      toolCallId: "call-2",
      id: "record_decision",
      args: {},
      reason: null,
    });

    expect(result).toEqual({ deniedMessage: expect.stringContaining("Not available") });
    expect(await waitForApproval("call-2", { timeoutMs: 1000 })).toBe(false);
    expect(await sql`SELECT 1 FROM heads_down_questions`).toHaveLength(0);
  });
});

describe("merge alerts", () => {
  it("shows an announced merge in the bell with its risk, and remembers it for the pass", async () => {
    const announced = new Set<string>();
    const tools = buildPassTools(db, newPassOutcome(), () => {}, announced);
    await tools.announce_merge.execute!(
      {
        repo: "acme/infra",
        number: 7,
        title: "Bump the load balancer timeout",
        risk: "high",
        why: "The user approved it after I asked.",
      },
      { toolCallId: "t1", messages: [] } as never,
    );

    expect([...announced]).toEqual(["acme/infra#7"]);
    const [item] = await sql`SELECT title, body, payload FROM attention_items`;
    expect(item).toMatchObject({
      title: "Heads down is merging acme/infra#7",
      body: "Bump the load balancer timeout\nThe user approved it after I asked.",
      payload: { headsDownMerge: { risk: "high", repo: "acme/infra", number: 7 } },
    });
  });

  it("finds the PR a merge-like MCP call merges, and ignores calls that only ask about one", () => {
    expect(
      mergeCallTarget("mcp:github:merge_pull_request", {
        owner: "acme",
        repo: "billing",
        pullNumber: 12,
      }),
    ).toEqual({ repo: "acme/billing", number: 12 });
    expect(
      mergeCallTarget("mcp:gh:mergePR", { url: "https://github.com/acme/web/pull/3" }),
    ).toEqual({ repo: "acme/web", number: 3 });
    expect(mergeCallTarget("mcp:gh:merge", { pr_number: "9" })).toEqual({ repo: "", number: 9 });
    expect(mergeCallTarget("mcp:gh:get_mergeability", { pullNumber: 1 })).toBeNull();
    expect(mergeCallTarget("mcp:gh:merge_pull_request", { owner: "acme" })).toBeNull();
    expect(mergeCallTarget("archive_workspace", { pullNumber: 1 })).toBeNull();
  });
});
