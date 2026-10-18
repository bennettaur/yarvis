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
  await sql`TRUNCATE heads_down_runs, heads_down_messages, heads_down_questions, work_streams, memories, events RESTART IDENTITY CASCADE`;
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

    expect(await spendApproval(db, "archive_workspace", { ...args, archiveBranches: false })).toBe(
      false,
    );
    // Key order doesn't make it a different call.
    expect(
      await spendApproval(db, "archive_workspace", { archiveBranches: true, workspaceId }),
    ).toBe(true);
    expect(await spendApproval(db, "archive_workspace", args)).toBe(false);
  });
});

describe("what a pass may do", () => {
  it("files tickets and starts work without asking", async () => {
    expect(await decideCall(db, "start_work_on_issue", { repoId: "r", issueNumber: 1 })).toBe(
      "run",
    );
  });

  it("steers a workspace's session only when the workspace is linked to an open stream", async () => {
    const args = { workspaceId, instruction: "fix CI" };
    expect(await decideCall(db, "send_workspace_instruction", args)).toBe("ask");

    const stream = await createStream(db, { title: "ship billing" });
    await linkToStream(db, stream.id, { ref: { kind: "workspace", workspaceId } });
    expect(await decideCall(db, "send_workspace_instruction", args)).toBe("run");
  });

  it("asks about anything else, and refuses what a pass has no business calling", async () => {
    expect(await decideCall(db, "archive_workspace", { workspaceId })).toBe("ask");
    expect(await decideCall(db, "record_decision", {})).toBe("refuse");
  });

  it("turns a call that needs the user into an approval question, and doesn't run it", async () => {
    const queued: string[] = [];
    const hooks = passApprovalHooks(db, (id) => queued.push(id));
    await hooks.onRequest({ toolCallId: "call-1", id: "archive_workspace", args: { workspaceId } });

    expect(await waitForApproval("call-1", { timeoutMs: 1000 })).toBe(false);
    expect(queued).toHaveLength(1);
    const [question] = await sql`SELECT kind, action, status FROM heads_down_questions`;
    expect(question).toMatchObject({
      kind: "approval",
      action: "archive_workspace",
      status: "open",
    });
  });
});
