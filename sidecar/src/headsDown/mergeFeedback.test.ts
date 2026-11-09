import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { waitForApproval } from "../mcp/approvals.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import type { PrCodeSource } from "../pr/source.ts";
import type { PrDetail, PrRef, ReviewThread } from "../pr/types.ts";
import { createStream, linkToStream } from "../workStreams/service.ts";
import type { SendSessionInstructionInput } from "../workspaces/claudeSession.ts";
import {
  feedbackIn,
  feedbackInstruction,
  feedbackSummary,
  type MergeSubject,
  mergeFeedbackLoader,
} from "./mergeFeedback.ts";
import { buildPassTools, newPassOutcome } from "./passTools.ts";
import { isMergeInstruction, passApprovalHooks } from "./policy.ts";
import { answerQuestion, pauseRun, startRun } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const memory = new PgVectorMemoryStore(db, new HashEmbedder());

beforeEach(async () => {
  await sql`TRUNCATE heads_down_runs, heads_down_questions, work_streams, workspaces, repos, agent_tools, attention_items, memories, events RESTART IDENTITY CASCADE`;
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
    comments: [
      { id: "c1", author: "sam", body: "This drops the retry.", createdAt: "", trusted: true },
    ],
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
async function workspaceWithPr({
  name = "billing",
  owner = "acme",
  cloneUrl,
  number = 12,
}: {
  name?: string;
  owner?: string;
  cloneUrl?: string;
  number?: number | null;
} = {}): Promise<string> {
  cloneUrl ??= `git@github.com:${owner}/${name}.git`;
  const [repo] = await db
    .insert(schema.repos)
    .values({ name, owner, repo: name, cloneUrl, primaryClonePath: `/tmp/${name}` })
    .returning();
  const [ws] = await db
    .insert(schema.workspaces)
    .values({ name, slug: name, status: "active", rootPath: `/tmp/ws-${name}` })
    .returning();
  const [wr] = await db
    .insert(schema.workspaceRepos)
    .values({
      workspaceId: ws!.id,
      repoId: repo!.id,
      branch: "monthly",
      baseBranch: "main",
      worktreePath: `/tmp/ws-${name}/${name}`,
    })
    .returning();
  if (number !== null) {
    await db
      .insert(schema.workspaceRepoPr)
      .values({ workspaceRepoId: wr!.id, prNumber: number, prState: "open" });
  }
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
          {
            login: "sam",
            state: "changes_requested",
            isRequested: false,
            isTeam: false,
            trusted: true,
          },
          { login: "kim", state: "approved", isRequested: false, isTeam: false },
        ],
      }),
    );
    expect(found.threadCount).toBe(1);
    expect(found.threads[0]).toMatchObject({ author: "sam", body: "This drops the retry." });
    expect(found.changesRequestedBy).toEqual(["sam"]);
    expect(found.fromOutsiders).toBe(false);
  });

  it("still counts a review asking for changes after the reviewer is asked to look again", () => {
    const found = feedbackIn(
      detail({
        reviewers: [
          {
            login: "sam",
            state: "pending",
            isRequested: true,
            isTeam: false,
            trusted: true,
            previousState: "changes_requested",
          },
        ],
      }),
    );
    expect(found.changesRequestedBy).toEqual(["sam"]);
    expect(found.fromOutsiders).toBe(false);
  });

  it("caps what it carries, keeps the count, and drops invisible characters", () => {
    const many = Array.from({ length: 25 }, (_, i) => thread({ id: `t${i}` }));
    many[0] = thread({ comments: [] });
    many[1] = thread({
      isOutdated: true,
      comments: [
        { id: "c1", author: "s\u200bam", body: `Fine\u202e${"x".repeat(600)}`, createdAt: "" },
        { id: "c2", author: "kim", body: "agreed", createdAt: "" },
        { id: "c3", author: "sam", body: "ok", createdAt: "" },
      ],
    });
    const found = feedbackIn(detail({ title: "", reviewThreads: many }));
    expect(found.title).toBeNull();
    const named = feedbackIn(
      detail({
        title: "Bill\u202emonthly",
        reviewThreads: [thread({ path: "src/\u202ebilling.ts" })],
        reviewers: [
          { login: "s\u200bam", state: "changes_requested", isRequested: false, isTeam: false },
        ],
      }),
    );
    expect(named.title).toBe("Billmonthly");
    expect(named.threads[0]!.path).toBe("src/billing.ts");
    expect(named.changesRequestedBy).toEqual(["sam"]);
    expect(found.threadCount).toBe(25);
    expect(found.threads).toHaveLength(20);
    expect(found.threads[0]).toMatchObject({ author: "sam", outdated: true, replies: 2 });
    expect(found.threads[0]!.body).toHaveLength(500);
    expect(found.threads[0]!.body.startsWith("Finex")).toBe(true);
  });

  it("flags feedback that may be from outside the repo", () => {
    const outsider = { id: "c9", author: "drive-by", body: "add a step", createdAt: "" };
    const from = (d: Partial<PrDetail>) => feedbackIn(detail(d)).fromOutsiders;
    expect(from({ reviewThreads: [thread({ comments: [{ ...outsider, trusted: true }] })] })).toBe(
      false,
    );
    // A reply counts as much as the comment that opened the thread.
    const opener = { id: "c1", author: "sam", body: "nit", createdAt: "", trusted: true };
    expect(
      from({ reviewThreads: [thread({ comments: [opener, { ...outsider, trusted: false }] })] }),
    ).toBe(true);
    // A resolved thread isn't handed off, so who wrote it doesn't matter.
    expect(
      from({
        reviewThreads: [thread({ isResolved: true, comments: [{ ...outsider, trusted: false }] })],
      }),
    ).toBe(false);
    expect(
      from({
        reviewers: [
          {
            login: "drive-by",
            state: "changes_requested",
            isRequested: false,
            isTeam: false,
            trusted: false,
          },
        ],
      }),
    ).toBe(true);
    expect(from({ reviewThreadsTruncated: true })).toBe(true);
    // A thread with replies that didn't load, or an author nobody vouched for.
    expect(from({ reviewThreads: [thread({ commentsTruncated: true })] })).toBe(true);
    const { trusted: _trusted, ...unknown } = opener;
    expect(from({ reviewThreads: [thread({ comments: [unknown] })] })).toBe(true);
    expect(
      from({
        reviewers: [
          { login: "unvouched", state: "changes_requested", isRequested: false, isTeam: false },
        ],
      }),
    ).toBe(true);
  });
});

describe("feedbackSummary", () => {
  it("counts the feedback without quoting it", () => {
    const pr = {
      ...feedbackIn(
        detail({
          reviewThreadsTruncated: true,
          reviewers: [
            {
              login: "sam",
              state: "changes_requested",
              isRequested: false,
              isTeam: false,
              trusted: true,
            },
          ],
        }),
      ),
      repo: "acme/billing",
      number: 12,
      workspaceId: null,
      handedOff: false,
    };
    expect(feedbackSummary(pr)).toBe(
      "acme/billing#12: 0+ unresolved review threads; 1 review asking for changes",
    );
    expect(
      feedbackSummary({ ...pr, threadsTruncated: false, threadCount: 1, changesRequestedBy: [] }),
    ).toBe("acme/billing#12: 1 unresolved review thread");
  });
});

describe("mergeFeedbackLoader", () => {
  const subject = { repo: "acme/billing", number: 12, githubOnly: true };

  it("finds the feedback and the workspace that owns the PR", async () => {
    const workspaceId = await workspaceWithPr();
    const asked: PrRef[] = [];
    const load = mergeFeedbackLoader(
      db,
      {} as never,
      fakeSources(detail({ reviewThreads: [thread()] }), asked),
    );
    const result = await load({ ...subject, repo: "ACME/Billing" });
    expect(result.unchecked).toBeNull();
    expect(result.prs).toEqual([
      expect.objectContaining({ repo: "acme/billing", workspaceId, handedOff: false }),
    ]);
    expect(asked).toEqual([{ provider: "github", owner: "acme", repo: "billing", number: 12 }]);

    // Through a session, the PR is the workspace's own.
    expect((await load({ workspaceId })).prs.map((p) => p.number)).toEqual([12]);
  });

  it("reports nothing for a PR with no open feedback", async () => {
    const load = mergeFeedbackLoader(db, {} as never, fakeSources(detail()));
    expect(await load(subject)).toEqual({ prs: [], unchecked: null });
  });

  it("counts a review asking for changes as feedback, even with no threads", async () => {
    const load = mergeFeedbackLoader(
      db,
      {} as never,
      fakeSources(
        detail({
          reviewers: [
            {
              login: "sam",
              state: "changes_requested",
              isRequested: false,
              isTeam: false,
              trusted: true,
            },
          ],
        }),
      ),
    );
    const { prs } = await load(subject);
    expect(prs).toHaveLength(1);
    expect(prs[0]!.changesRequestedBy).toEqual(["sam"]);
  });

  it("checks only the merging workspace's own open PR", async () => {
    const billing = await workspaceWithPr();
    const web = await workspaceWithPr({ name: "web", number: 5 });
    const load = mergeFeedbackLoader(
      db,
      {} as never,
      fakeSources(detail({ reviewThreads: [thread()] })),
    );
    expect((await load({ workspaceId: billing })).prs.map((p) => p.repo)).toEqual(["acme/billing"]);
    expect((await load({ workspaceId: web })).prs.map((p) => p.repo)).toEqual(["acme/web"]);

    // A closed PR, or an archived workspace, owns nothing.
    await sql`UPDATE workspace_repo_pr SET pr_state = 'closed' WHERE pr_number = 5`;
    expect((await load({ workspaceId: web })).unchecked).toContain("no open PR");
    await sql`UPDATE workspaces SET status = 'archived' WHERE id = ${billing}`;
    expect((await load(subject)).prs[0]!.workspaceId).toBeNull();
  });

  it("leaves a workspace's merge unchecked until it knows the workspace's PR", async () => {
    const load = mergeFeedbackLoader(db, {} as never, fakeSources(detail()));
    const noPr = await workspaceWithPr({ number: null });
    expect((await load({ workspaceId: noPr })).unchecked).toContain("no open PR");
    const unknownHost = await workspaceWithPr({
      name: "odd",
      owner: "",
      cloneUrl: "not a url",
    });
    expect((await load({ workspaceId: unknownHost })).unchecked).toContain(
      "can't tell which provider",
    );
  });

  it("counts threads it couldn't load as feedback", async () => {
    const load = mergeFeedbackLoader(
      db,
      {} as never,
      fakeSources(detail({ reviewThreadsTruncated: true })),
    );
    expect((await load(subject)).prs).toHaveLength(1);
  });

  it("leaves the merge unchecked when it can't tell or read the PR", async () => {
    const failing = mergeFeedbackLoader(db, {} as never, () => ({ error: "no token" }));
    expect(await failing(subject)).toEqual({ prs: [], unchecked: "no token" });

    const throwing = mergeFeedbackLoader(db, {} as never, (ref) => {
      return { ref, detail: async () => Promise.reject(new Error("boom")) } as never;
    });
    expect((await throwing(subject)).unchecked).toBe("reading the PR failed: boom");
    const leaky = mergeFeedbackLoader(db, {} as never, (ref) => {
      const token = `ghp_${"a".repeat(36)}`;
      return { ref, detail: async () => Promise.reject(new Error(`401 for ${token}`)) } as never;
    });
    expect((await leaky(subject)).unchecked).not.toContain("ghp_");

    const any = mergeFeedbackLoader(db, {} as never, fakeSources(detail()));
    // A number alone could be another repo's PR.
    expect((await any({ ...subject, repo: "" })).unchecked).toContain("doesn't name");
    expect((await any({ ...subject, repo: "acme/billing/x" })).unchecked).toContain("doesn't name");
    // No workspace has it, and the tool may not be GitHub's.
    expect((await any({ ...subject, githubOnly: false })).unchecked).toContain(
      "may not be GitHub's",
    );
  });
});

describe("merging with open feedback", () => {
  const withFeedback = () =>
    mergeFeedbackLoader(db, {} as never, fakeSources(detail({ reviewThreads: [thread()] })));
  const sent: SendSessionInstructionInput[] = [];
  const send = async (input: SendSessionInstructionInput) => {
    sent.push(input);
  };

  beforeEach(() => {
    sent.length = 0;
  });

  it("tells the session to leave a thread it won't change open for the user", () => {
    const instruction = feedbackInstruction({ repo: "acme/billing", number: 12 });
    expect(instruction).toContain("Resolve only the threads your pushed change addresses.");
    expect(instruction).toContain("leave it open for the user");
    expect(instruction).not.toContain("Resolve the threads you've handled");
  });

  it("isn't fooled into seeing the handoff as a merge", () => {
    expect(isMergeInstruction(feedbackInstruction({ repo: "acme/billing", number: 12 }))).toBe(
      false,
    );
  });

  /** A workspace the user put on a stream, so a pass may steer its session. */
  async function pushedWorkspace(): Promise<string> {
    const workspaceId = await workspaceWithPr();
    const stream = await createStream(db, { title: "ship billing" });
    await linkToStream(db, stream.id, { ref: { kind: "workspace", workspaceId } });
    return workspaceId;
  }

  it("tells the workspace's session to address it first, then asks the user with it shown", async () => {
    const workspaceId = await pushedWorkspace();
    const run = await startRun(db, null);
    await allowUnattended(mergeTool);
    const hooks = passApprovalHooks(db, run, () => {}, {
      mergeFeedback: withFeedback(),
      sendInstruction: send,
    });

    const first = await hooks.onRequest({
      toolCallId: "m1",
      id: mergeTool,
      args: mergeArgs,
      reason: null,
    });
    expect(await waitForApproval("m1", { timeoutMs: 1000 })).toBe(false);
    expect(sent).toEqual([
      expect.objectContaining({
        workspaceId,
        instruction: feedbackInstruction({ repo: "acme/billing", number: 12 }),
      }),
    ]);
    expect(first?.deniedMessage).toContain(`handed to workspace ${workspaceId}`);
    expect(first?.deniedMessage).not.toContain("drops the retry");
    expect(await sql`SELECT 1 FROM heads_down_questions`).toHaveLength(0);

    // Still open on the next try: the user decides, with the feedback in the modal.
    await hooks.onRequest({ toolCallId: "m2", id: mergeTool, args: mergeArgs, reason: null });
    expect(await waitForApproval("m2", { timeoutMs: 1000 })).toBe(false);
    expect(sent).toHaveLength(1);
    const [question] = await sql`SELECT id, question FROM heads_down_questions`;
    expect(question!.question).toBe("Merge acme/billing#12? It has open review feedback.");
    const [item] = await sql`SELECT kind, payload FROM attention_items`;
    expect(item).toMatchObject({
      kind: "permission",
      payload: {
        headsDownMergeReview: {
          questionId: question!.id,
          unchecked: null,
          prs: [expect.objectContaining({ number: 12, threadCount: 1, handedOff: true })],
        },
      },
    });

    await answerQuestion(db, memory, question!.id, { choice: "approve" });
    await hooks.onRequest({ toolCallId: "m3", id: mergeTool, args: mergeArgs, reason: null });
    expect(await waitForApproval("m3", { timeoutMs: 1000 })).toBe(true);
  });

  it("holds a merge told to the session too, even on a workspace it may steer", async () => {
    const workspaceId = await pushedWorkspace();
    const run = await startRun(db, null);
    const hooks = passApprovalHooks(db, run, () => {}, {
      mergeFeedback: withFeedback(),
      sendInstruction: send,
    });
    const args = { workspaceId, instruction: "Merge the PR now." };

    await hooks.onRequest({
      toolCallId: "s1",
      id: "send_workspace_instruction",
      args,
      reason: null,
    });
    expect(await waitForApproval("s1", { timeoutMs: 1000 })).toBe(false);
    expect(sent).toHaveLength(1);

    // Other steering still runs while the merge is held.
    await hooks.onRequest({
      toolCallId: "s2",
      id: "send_workspace_instruction",
      args: { workspaceId, instruction: "fix CI" },
      reason: null,
    });
    expect(await waitForApproval("s2", { timeoutMs: 1000 })).toBe(true);
  });

  it("hands off again in a new run, and goes to the user when the send fails", async () => {
    await pushedWorkspace();
    await allowUnattended(mergeTool);
    const first = await startRun(db, null);
    await passApprovalHooks(db, first, () => {}, {
      mergeFeedback: withFeedback(),
      sendInstruction: send,
    }).onRequest({ toolCallId: "r1", id: mergeTool, args: mergeArgs, reason: null });
    expect(sent).toHaveLength(1);
    await sql`UPDATE heads_down_runs SET status = 'stopped'`;

    const second = await startRun(db, null);
    await passApprovalHooks(db, second, () => {}, {
      mergeFeedback: withFeedback(),
      sendInstruction: async () => {
        throw new Error("no agent session");
      },
    }).onRequest({ toolCallId: "r2", id: mergeTool, args: mergeArgs, reason: null });
    expect(await waitForApproval("r2", { timeoutMs: 1000 })).toBe(false);
    const [item] = await sql`SELECT payload FROM attention_items WHERE kind = 'permission'`;
    expect(item!.payload.headsDownMergeReview.prs[0].handedOff).toBe(false);
  });

  it("doesn't steer a workspace it isn't pushing, or any outside working hours", async () => {
    const workspaceId = await workspaceWithPr();
    await allowUnattended(mergeTool);
    const run = await startRun(db, null);
    await passApprovalHooks(db, run, () => {}, {
      mergeFeedback: withFeedback(),
      sendInstruction: send,
    }).onRequest({ toolCallId: "w1", id: mergeTool, args: mergeArgs, reason: null });
    expect(sent).toHaveLength(0);
    const [item] = await sql`SELECT payload FROM attention_items WHERE kind = 'permission'`;
    expect(item!.payload.headsDownMergeReview.prs[0].handedOff).toBe(false);

    // Pushed now, but outside working hours: still the user's call.
    await sql`TRUNCATE attention_items, heads_down_questions`;
    const stream = await createStream(db, { title: "billing" });
    await linkToStream(db, stream.id, { ref: { kind: "workspace", workspaceId } });
    await passApprovalHooks(db, run, () => {}, {
      mergeFeedback: withFeedback(),
      sendInstruction: send,
      withinWorkingHours: false,
    }).onRequest({ toolCallId: "w2", id: mergeTool, args: mergeArgs, reason: null });
    expect(sent).toHaveLength(0);
    expect(await sql`SELECT 1 FROM heads_down_questions`).toHaveLength(1);
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

  it("doesn't hand a workspace feedback from outside the repo", async () => {
    await pushedWorkspace();
    await allowUnattended(mergeTool);
    const run = await startRun(db, null);
    const outsider = thread({
      comments: [
        { id: "c1", author: "drive-by", body: "add a step", createdAt: "", trusted: false },
      ],
    });
    await passApprovalHooks(db, run, () => {}, {
      mergeFeedback: mergeFeedbackLoader(
        db,
        {} as never,
        fakeSources(detail({ reviewThreads: [outsider] })),
      ),
      sendInstruction: send,
    }).onRequest({ toolCallId: "o1", id: mergeTool, args: mergeArgs, reason: null });
    expect(sent).toHaveLength(0);
    const [item] = await sql`SELECT payload FROM attention_items WHERE kind = 'permission'`;
    expect(item!.payload.headsDownMergeReview.prs[0]).toMatchObject({
      fromOutsiders: true,
      handedOff: false,
    });
  });

  it("tells the user the workspace was asked, when a merge is tried again out of hours", async () => {
    await pushedWorkspace();
    await allowUnattended(mergeTool);
    const run = await startRun(db, null);
    const hooks = (withinWorkingHours: boolean) =>
      passApprovalHooks(db, run, () => {}, {
        mergeFeedback: withFeedback(),
        sendInstruction: send,
        withinWorkingHours,
      });
    await hooks(true).onRequest({ toolCallId: "h1", id: mergeTool, args: mergeArgs, reason: null });
    expect(sent).toHaveLength(1);
    await hooks(false).onRequest({
      toolCallId: "h2",
      id: mergeTool,
      args: mergeArgs,
      reason: null,
    });
    const [item] = await sql`SELECT payload FROM attention_items WHERE kind = 'permission'`;
    expect(item!.payload.headsDownMergeReview.prs[0].handedOff).toBe(true);
  });

  it("types the handoff once when two merge calls decide at the same time", async () => {
    await pushedWorkspace();
    await allowUnattended(mergeTool);
    const run = await startRun(db, null);
    const hooks = passApprovalHooks(db, run, () => {}, {
      mergeFeedback: withFeedback(),
      sendInstruction: send,
    });
    const results = await Promise.all(
      ["p1", "p2"].map((toolCallId) =>
        hooks.onRequest({ toolCallId, id: mergeTool, args: mergeArgs, reason: null }),
      ),
    );
    expect(sent).toHaveLength(1);
    for (const result of results) expect(result?.deniedMessage).toContain("handed to workspace");
    expect(await sql`SELECT 1 FROM heads_down_questions`).toHaveLength(0);
  });

  it("gives the handoff back when the send fails, so a later try can send it", async () => {
    await pushedWorkspace();
    await allowUnattended(mergeTool);
    const run = await startRun(db, null);
    await passApprovalHooks(db, run, () => {}, {
      mergeFeedback: withFeedback(),
      sendInstruction: async () => {
        throw new Error("no agent session");
      },
    }).onRequest({ toolCallId: "f1", id: mergeTool, args: mergeArgs, reason: null });
    expect(await sql`SELECT 1 FROM heads_down_feedback_handoffs`).toHaveLength(0);

    await passApprovalHooks(db, run, () => {}, {
      mergeFeedback: withFeedback(),
      sendInstruction: send,
    }).onRequest({ toolCallId: "f2", id: mergeTool, args: mergeArgs, reason: null });
    expect(sent).toHaveLength(1);
  });

  it("leaves unchecked a merge through a server that isn't GitHub's, or that names no PR", async () => {
    const run = await startRun(db, null);
    const azure = "mcp:azure-devops:merge_pull_request";
    await allowUnattended(azure);
    const hooks = passApprovalHooks(db, run, () => {}, { mergeFeedback: withFeedback() });
    await hooks.onRequest({ toolCallId: "z1", id: azure, args: mergeArgs, reason: null });
    expect(await waitForApproval("z1", { timeoutMs: 1000 })).toBe(false);
    await hooks.onRequest({
      toolCallId: "z2",
      id: "send_workspace_instruction",
      args: { instruction: "Merge the PR now." },
      reason: null,
    });
    const items = await sql`SELECT payload FROM attention_items WHERE kind = 'permission'`;
    expect(items.map((i) => i.payload.headsDownMergeReview.unchecked)).toEqual([
      expect.stringContaining("may not be GitHub's"),
      expect.stringContaining("doesn't say which PR"),
    ]);
  });

  it("checks a merge told to a session against its own PR and every PR it names", async () => {
    const workspaceId = await pushedWorkspace();
    const run = await startRun(db, null);
    const asked: MergeSubject[] = [];
    const load = withFeedback();
    const hooks = passApprovalHooks(db, run, () => {}, {
      mergeFeedback: (subject) => {
        asked.push(subject);
        // The workspace's own PR is clean, so the named PRs get read.
        return "workspaceId" in subject
          ? Promise.resolve({ prs: [], unchecked: null })
          : load(subject);
      },
      sendInstruction: send,
    });
    await hooks.onRequest({
      toolCallId: "n1",
      id: "send_workspace_instruction",
      args: {
        workspaceId,
        instruction: "Merge acme/web#5, then https://github.com/acme/api/pull/7 and acme/web#5.",
      },
      reason: null,
    });
    expect(await waitForApproval("n1", { timeoutMs: 1000 })).toBe(false);
    // The first PR no workspace owns leaves the merge unchecked, so nothing after it is read.
    expect(asked).toEqual([{ workspaceId }, { repo: "acme/api", number: 7, githubOnly: false }]);
    const [item] = await sql`SELECT payload FROM attention_items WHERE kind = 'permission'`;
    expect(item!.payload.headsDownMergeReview.unchecked).toContain("may not be GitHub's");

    // With every PR clean, each one is read once, URLs first.
    asked.length = 0;
    await passApprovalHooks(db, run, () => {}, {
      mergeFeedback: (subject) => {
        asked.push(subject);
        return Promise.resolve({ prs: [], unchecked: null });
      },
      sendInstruction: send,
    }).onRequest({
      toolCallId: "n3",
      id: "send_workspace_instruction",
      args: {
        workspaceId,
        instruction: "Merge acme/web#5, then https://github.com/acme/api/pull/7 and acme/web#5.",
      },
      reason: null,
    });
    expect(asked).toEqual([
      { workspaceId },
      { repo: "acme/api", number: 7, githubOnly: false },
      { repo: "acme/web", number: 5, githubOnly: false },
    ]);
  });

  it("holds a merge told to a session for its own PR's feedback, even when the named PR is clean", async () => {
    const workspaceId = await pushedWorkspace();
    const run = await startRun(db, null);
    const ownFeedback = withFeedback();
    await passApprovalHooks(db, run, () => {}, {
      mergeFeedback: (subject) =>
        "workspaceId" in subject
          ? ownFeedback(subject)
          : Promise.resolve({ prs: [], unchecked: null }),
      sendInstruction: send,
    }).onRequest({
      toolCallId: "n2",
      id: "send_workspace_instruction",
      args: { workspaceId, instruction: "Merge acme/web#5 and your own PR." },
      reason: null,
    });
    expect(await waitForApproval("n2", { timeoutMs: 1000 })).toBe(false);
    expect(sent.map((s) => s.workspaceId)).toEqual([workspaceId]);
    expect(sent[0]?.instruction).toContain("acme/billing#12");
  });

  it("doesn't read the PR for a merge the run won't make anyway", async () => {
    const run = await startRun(db, null);
    const asked: MergeSubject[] = [];
    await pauseRun(db);
    const result = await passApprovalHooks(db, run, () => {}, {
      mergeFeedback: async (subject) => {
        asked.push(subject);
        return { prs: [], unchecked: null };
      },
    }).onRequest({ toolCallId: "x1", id: mergeTool, args: mergeArgs, reason: null });
    expect(result?.deniedMessage).toBeDefined();
    expect(asked).toEqual([]);
  });

  it("won't announce a merge that is held", async () => {
    await workspaceWithPr();
    const announced = new Set<string>();
    const tools = buildPassTools(db, newPassOutcome(), () => {}, announced, [], withFeedback());
    const result = await tools.announce_merge.execute!(
      { repo: "acme/billing", number: 12, risk: "low", why: "Docs only." },
      { toolCallId: "a1", messages: [] } as never,
    );
    expect(result).toMatchObject({ ok: false });
    expect(announced.size).toBe(0);
    expect(await sql`SELECT 1 FROM attention_items`).toHaveLength(0);
  });

  it("announces a workspace's merge with no open feedback, but not one it can't check", async () => {
    const clean = mergeFeedbackLoader(db, {} as never, fakeSources(detail()));
    const announced = new Set<string>();
    const tools = buildPassTools(db, newPassOutcome(), () => {}, announced, [], clean);
    const announce = (repo: string, number: number) =>
      tools.announce_merge.execute!({ repo, number, risk: "low", why: "Docs only." }, {
        toolCallId: "a2",
        messages: [],
      } as never);

    // No workspace owns it, and announce_merge can't tell which merge tool will run.
    expect(await announce("acme/billing", 12)).toMatchObject({ ok: false });

    await workspaceWithPr();
    expect(await announce("acme/billing", 12)).toMatchObject({ ok: true });
    expect([...announced]).toEqual(["acme/billing#12"]);
    expect(await sql`SELECT 1 FROM attention_items WHERE kind = 'info'`).toHaveLength(1);
  });
});
