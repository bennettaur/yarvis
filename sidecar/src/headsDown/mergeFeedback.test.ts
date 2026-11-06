import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { waitForApproval } from "../mcp/approvals.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import type { PrCodeSource } from "../pr/source.ts";
import type { PrDetail, PrRef, ReviewThread } from "../pr/types.ts";
import { feedbackIn, mergeFeedbackLoader } from "./mergeFeedback.ts";
import { passApprovalHooks } from "./policy.ts";
import { answerQuestion, startRun } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const memory = new PgVectorMemoryStore(db, new HashEmbedder());

beforeEach(async () => {
  await sql`TRUNCATE heads_down_runs, heads_down_questions, workspaces, repos, agent_tools, attention_items, memories, events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "t1",
    path: "src/billing.ts",
    line: 10,
    side: "RIGHT",
    isResolved: false,
    isOutdated: false,
    canReply: true,
    canResolve: true,
    canUnresolve: false,
    comments: [{ id: "c1", author: "sam", body: "This drops the retry.", createdAt: "" }],
    ...overrides,
  };
}

function detail(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    title: "Bill monthly",
    reviewThreads: [],
    reviewers: [],
    ...overrides,
  } as PrDetail;
}

/** A source that serves `pr` for every ref, recording which refs were asked for. */
function fakeSources(pr: PrDetail, asked: PrRef[] = []) {
  return (ref: PrRef) => {
    asked.push(ref);
    return { ref, detail: async () => pr } as unknown as PrCodeSource;
  };
}

/** An active workspace whose branch is acme/billing#12, as the poller would have it. */
async function workspaceWithPr(): Promise<string> {
  const [repo] = await db
    .insert(schema.repos)
    .values({
      name: "billing",
      owner: "acme",
      repo: "billing",
      cloneUrl: "git@github.com:acme/billing.git",
      primaryClonePath: "/tmp/billing",
    })
    .returning();
  const [ws] = await db
    .insert(schema.workspaces)
    .values({ name: "Billing", slug: "billing", status: "active", rootPath: "/tmp/ws" })
    .returning();
  const [wr] = await db
    .insert(schema.workspaceRepos)
    .values({
      workspaceId: ws!.id,
      repoId: repo!.id,
      branch: "monthly",
      baseBranch: "main",
      worktreePath: "/tmp/ws/billing",
    })
    .returning();
  await db
    .insert(schema.workspaceRepoPr)
    .values({ workspaceRepoId: wr!.id, prNumber: 12, prState: "open" });
  return ws!.id;
}

const mergeTool = "mcp:github:merge_pull_request";
const mergeArgs = { owner: "acme", repo: "billing", pullNumber: 12 };

async function allowUnattended(tool: string) {
  await sql`INSERT INTO agent_tools (id, source, name, content_hash, unattended)
            VALUES (${tool}, 'mcp', ${tool.slice(tool.lastIndexOf(":") + 1)}, 'h', true)`;
}

describe("feedbackIn", () => {
  it("keeps unresolved threads and reviews asking for changes", () => {
    const found = feedbackIn(
      detail({
        reviewThreads: [thread(), thread({ id: "t2", isResolved: true })],
        reviewers: [
          { login: "sam", state: "changes_requested", isRequested: false, isTeam: false },
          { login: "kim", state: "approved", isRequested: false, isTeam: false },
        ],
      }),
    );
    expect(found.threadCount).toBe(1);
    expect(found.threads[0]).toMatchObject({ author: "sam", body: "This drops the retry." });
    expect(found.changesRequestedBy).toEqual(["sam"]);
  });
});

describe("mergeFeedbackLoader", () => {
  it("finds the feedback and the workspace that owns the PR", async () => {
    const workspaceId = await workspaceWithPr();
    const asked: PrRef[] = [];
    const load = mergeFeedbackLoader(
      db,
      {} as never,
      fakeSources(detail({ reviewThreads: [thread()] }), asked),
    );
    const result = await load(mergeTool, mergeArgs);
    expect(result.unchecked).toBeNull();
    expect(result.prs).toEqual([expect.objectContaining({ repo: "acme/billing", workspaceId })]);
    expect(asked).toEqual([{ provider: "github", owner: "acme", repo: "billing", number: 12 }]);

    // Told to a session, the PR is the workspace's own.
    const viaSession = await load("send_workspace_instruction", {
      workspaceId,
      instruction: "merge the PR",
    });
    expect(viaSession.prs.map((p) => p.number)).toEqual([12]);
  });

  it("reports nothing for a PR with no open feedback", async () => {
    const load = mergeFeedbackLoader(db, {} as never, fakeSources(detail()));
    expect(await load(mergeTool, mergeArgs)).toEqual({ prs: [], unchecked: null });
  });

  it("leaves the merge unchecked when the PR can't be read", async () => {
    const load = mergeFeedbackLoader(db, {} as never, () => ({
      error: "github token not configured",
    }));
    expect(await load(mergeTool, mergeArgs)).toEqual({
      prs: [],
      unchecked: "github token not configured",
    });
  });
});

describe("merging with open feedback", () => {
  const withFeedback = () =>
    mergeFeedbackLoader(db, {} as never, fakeSources(detail({ reviewThreads: [thread()] })));

  it("hands the feedback to the workspace first, then asks the user with it shown", async () => {
    const workspaceId = await workspaceWithPr();
    const run = await startRun(db, null);
    await allowUnattended(mergeTool);
    const hooks = passApprovalHooks(db, run, () => {}, { mergeFeedback: withFeedback() });

    const first = await hooks.onRequest({
      toolCallId: "m1",
      id: mergeTool,
      args: mergeArgs,
      reason: null,
    });
    expect(await waitForApproval("m1", { timeoutMs: 1000 })).toBe(false);
    expect(first?.deniedMessage).toContain(`workspaceId ${workspaceId}`);
    expect(first?.deniedMessage).toContain("There is open review feedback on PR acme/billing#12");
    expect(first?.deniedMessage).not.toContain("drops the retry");
    expect(await sql`SELECT 1 FROM heads_down_questions`).toHaveLength(0);

    // Still open on the next try: the user decides, with the feedback in the modal.
    await hooks.onRequest({ toolCallId: "m2", id: mergeTool, args: mergeArgs, reason: null });
    expect(await waitForApproval("m2", { timeoutMs: 1000 })).toBe(false);
    const [question] = await sql`SELECT id, question FROM heads_down_questions`;
    expect(question!.question).toBe("Merge acme/billing#12? It has open review feedback.");
    const [item] = await sql`SELECT kind, payload FROM attention_items`;
    expect(item).toMatchObject({
      kind: "permission",
      payload: {
        headsDownMergeReview: {
          questionId: question!.id,
          unchecked: null,
          prs: [expect.objectContaining({ number: 12, threadCount: 1 })],
        },
      },
    });

    await answerQuestion(db, memory, question!.id, { choice: "approve" });
    await hooks.onRequest({ toolCallId: "m3", id: mergeTool, args: mergeArgs, reason: null });
    expect(await waitForApproval("m3", { timeoutMs: 1000 })).toBe(true);
  });

  it("asks the user straight away when no workspace owns the PR, and stops at a no", async () => {
    const run = await startRun(db, null);
    await allowUnattended(mergeTool);
    const hooks = passApprovalHooks(db, run, () => {}, { mergeFeedback: withFeedback() });

    await hooks.onRequest({ toolCallId: "m4", id: mergeTool, args: mergeArgs, reason: null });
    expect(await waitForApproval("m4", { timeoutMs: 1000 })).toBe(false);
    const [question] = await sql`SELECT id FROM heads_down_questions`;
    expect(question).toBeDefined();

    await answerQuestion(db, memory, question!.id, { choice: "deny" });
    const again = await hooks.onRequest({
      toolCallId: "m5",
      id: mergeTool,
      args: mergeArgs,
      reason: null,
    });
    expect(await waitForApproval("m5", { timeoutMs: 1000 })).toBe(false);
    expect(again?.deniedMessage).toContain("the user denied this exact call");
  });

  it("asks the user when the feedback couldn't be checked", async () => {
    const run = await startRun(db, null);
    await allowUnattended(mergeTool);
    const hooks = passApprovalHooks(db, run, () => {}, {
      mergeFeedback: mergeFeedbackLoader(db, {} as never, () => ({ error: "no token" })),
    });
    await hooks.onRequest({ toolCallId: "m6", id: mergeTool, args: mergeArgs, reason: null });
    expect(await waitForApproval("m6", { timeoutMs: 1000 })).toBe(false);
    const [item] = await sql`SELECT payload FROM attention_items WHERE kind = 'permission'`;
    expect(item!.payload.headsDownMergeReview.unchecked).toBe("no token");
  });

  it("merges a PR with no open feedback as before", async () => {
    const run = await startRun(db, null);
    await allowUnattended(mergeTool);
    const hooks = passApprovalHooks(db, run, () => {}, {
      mergeFeedback: mergeFeedbackLoader(db, {} as never, fakeSources(detail())),
    });
    await hooks.onRequest({ toolCallId: "m7", id: mergeTool, args: mergeArgs, reason: null });
    expect(await waitForApproval("m7", { timeoutMs: 1000 })).toBe(true);
  });
});
