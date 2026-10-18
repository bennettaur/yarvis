import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { waitForApproval } from "../mcp/approvals.ts";
import { readDecision } from "../memory/decisions.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import { createStream, linkToStream } from "../workStreams/service.ts";
import { decideCall, passApprovalHooks } from "./policy.ts";
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
  await sql`TRUNCATE heads_down_runs, heads_down_messages, heads_down_questions, work_streams, workspaces, memories, events RESTART IDENTITY CASCADE`;
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

  it("starts a session on the user's task, but asks about a brief it wrote", async () => {
    const run = await startRun(db, null);
    const base = { name: "billing", repoIds: [] };
    expect(await decideCall(db, run, "create_workspace_session", { ...base, taskId: "t1" })).toBe(
      "run",
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

  it("steers a workspace a pass started in this run and linked", async () => {
    const run = await startRun(db, null);
    await seedWorkspace(new Date(Date.now() + 1000));
    const stream = await createStream(db, { title: "ship billing" });
    await linkToStream(db, stream.id, {
      ref: { kind: "workspace", workspaceId },
      createdBy: "heads-down",
    });

    expect(
      await decideCall(db, run, "send_workspace_instruction", { workspaceId, instruction: "push" }),
    ).toBe("run");
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
    await hooks.onRequest({ toolCallId: "call-1", id: "archive_workspace", args: { workspaceId } });

    expect(await waitForApproval("call-1", { timeoutMs: 1000 })).toBe(false);
    expect(queued).toBe(1);
    const [question] = await sql`SELECT kind, action, status FROM heads_down_questions`;
    expect(question).toMatchObject({
      kind: "approval",
      action: "archive_workspace",
      status: "open",
    });
  });

  it("tells the model plainly when a tool isn't available, without filing a question", async () => {
    const run = await startRun(db, null);
    const hooks = passApprovalHooks(db, run, () => {});
    const result = await hooks.onRequest({ toolCallId: "call-2", id: "record_decision", args: {} });

    expect(result).toEqual({ deniedMessage: expect.stringContaining("Not available") });
    expect(await waitForApproval("call-2", { timeoutMs: 1000 })).toBe(false);
    expect(await sql`SELECT 1 FROM heads_down_questions`).toHaveLength(0);
  });
});
