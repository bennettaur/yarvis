import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { ProcessSlots } from "../agentRuns/service.ts";
import { fakeClaude } from "../agentRuns/testSupport.ts";
import { publish } from "../attention/hub.ts";
import { raiseAttention } from "../attention/raise.ts";
import { updateAttentionStatus } from "../attention/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, attentionItems, reviewPreps, reviewWorkspaces } from "../db/schema.ts";
import type { ReviewCandidate } from "../github/client.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import type { PrDetail, PrRef } from "../pr/types.ts";
import { printAgentAnswer, writeAgentAnswers } from "../reviewWorkspaces/fakeAgents.ts";
import { reviewGit } from "../reviewWorkspaces/git.ts";
import {
  backgroundSettled,
  type KickoffDeps,
  kickOffVerification,
} from "../reviewWorkspaces/kickoff.ts";
import type { PrMeta, ReviewDeps } from "../reviewWorkspaces/service.ts";
import { createTestRemote, type TestRemote } from "../reviewWorkspaces/testRepo.ts";
import { DEFAULT_SECTIONS, REPORT_SECTIONS } from "../reviewWorkspaces/verification.ts";
import {
  needsNoReview,
  prepAttentionKey,
  prepReview,
  prepsSettled,
  type ReviewPrepDeps,
  releasePrep,
  slotsInUse,
  startBackloggedPreps,
  watchPrepDismissals,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};

const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };
/** Has no branch on the test remote, so its checkout fails. */
const ref2: PrRef = { ...ref, number: 2 };
/** Also have no branch. */
const ref3: PrRef = { ...ref, number: 3 };
const ref4: PrRef = { ...ref, number: 4 };
const pass = { status: "pass", findings: [] };
const report = {
  summary: "A small change.",
  mustRead: [{ path: "src/a.ts", reason: "The change.", lines: null, flags: [] }],
  changeMap: { intent: "A small change.", themes: [] },
  claims: { items: [], gaps: [] },
  risk: { level: "low", clientImpact: "None.", mitigations: [], concerns: [] },
  tests: {
    status: "issues",
    findings: [
      {
        title: "No test",
        detail: "Nothing covers it.",
        severity: "medium",
        path: null,
        line: null,
      },
    ],
  },
  complexity: pass,
  performance: pass,
  comments: pass,
  malice: pass,
  observability: pass,
  quality: pass,
  approach: { rating: "no-simpler", reason: "Fits.", alternative: "" },
};
const meta: PrMeta = {
  title: "Feature work",
  author: "octocat",
  headRef: "feature",
  baseRef: "main",
  fromFork: true,
};

let remote: TestRemote;
let fakeDir: string;
let failingProgram: string;
let kickoff: KickoffDeps;
let prepDeps: ReviewPrepDeps;
let stack: PrRef[];
let maxConcurrent: number;
let maxReady: number;

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const release = () => writeFileSync(join(fakeDir, "release"), "");
const attention = () => db.select().from(attentionItems);
/** Review prep's own items; the confirmed kickoff a test starts the checks with rings its own bell. */
const prepItems = async () =>
  (await attention()).filter((a) => a.sessionKey?.startsWith("raise:system:review-prep:"));
const prepOf = async (r: PrRef) =>
  (await db.select().from(reviewPreps)).find(
    (p) => p.ref.provider === "github" && r.provider === "github" && p.ref.number === r.number,
  );

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, review_preps, agent_runs, attention_items RESTART IDENTITY CASCADE`;
  config.workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-prep-root-"));
  remote = createTestRemote();
  fakeDir = mkdtempSync(join(tmpdir(), "yarvis-prep-fake-"));
  writeAgentAnswers(fakeDir, report);
  const program = fakeClaude(
    fakeDir,
    "claude",
    `input=$(cat)
while [ -d "${fakeDir}" ] && [ ! -f "${fakeDir}/release" ]; do sleep 0.02; done
${printAgentAnswer(fakeDir)}`,
  );
  failingProgram = fakeClaude(
    fakeDir,
    "claude-fails",
    `cat > /dev/null
while [ -d "${fakeDir}" ] && [ ! -f "${fakeDir}/release" ]; do sleep 0.02; done
echo "agent blew up" >&2
exit 1`,
  );
  const review: ReviewDeps = {
    loadPr: async () => meta,
    remoteUrlFor: async () => remote.url,
    credentialsFor: () => undefined,
    setupScriptFor: async () => "bun install",
    git: () => reviewGit({ allowFileProtocol: true }),
  };
  kickoff = {
    review,
    verification: {
      loadDetail: async () =>
        ({
          title: "Feature work",
          body: "",
          author: "octocat",
          headRef: "feature",
          baseRef: "main",
          checks: [],
          reviewThreads: [],
        }) as unknown as PrDetail,
      loadTickets: async () => ({ tickets: [], notes: [] }),
      settings: async () => ({
        maxBudgetUsd: 100,
        sections: Object.fromEntries(REPORT_SECTIONS.map((s) => [s, { model: "haiku" as const }])),
      }),
      run: {
        program,
        registry: new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 }),
        instance: "test",
        slots: new ProcessSlots(12),
      },
    },
    isRegistered: async () => true,
    pollMs: 25,
  };
  stack = [];
  maxConcurrent = 2;
  maxReady = 5;
  prepDeps = {
    kickoff,
    loadStack: async (r) =>
      stack.some(
        (layer) =>
          layer.provider === "github" && r.provider === "github" && layer.number === r.number,
      )
        ? stack
        : [r],
    prepConfig: async () => ({ maxConcurrentVerifications: maxConcurrent, maxReady }),
  };
});

afterEach(async () => {
  release();
  await prepsSettled();
  await backgroundSettled();
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(config.workspacesRoot, { recursive: true, force: true });
  rmSync(remote.root, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

/** PR 1 checked out, with every default check started (confirmed) and held open by the fake. */
async function heldChecks(): Promise<void> {
  await kickOffVerification(db, config, ref, {}, kickoff);
  await until(
    async () => (await attention()).some((a) => a.title.includes("go-ahead")),
    "the checkout",
  );
  await sql`TRUNCATE attention_items`;
  const started = await kickOffVerification(db, config, ref, { confirmed: true }, kickoff);
  expect(started).toMatchObject({ status: "started" });
}

describe("prepReview", () => {
  it("opens a workspace, and asks for a go-ahead rather than verifying a large PR", async () => {
    const result = await prepReview(db, config, ref, prepDeps);
    expect(result).toMatchObject({ status: "queued", pr: "r#1", createdWorkspace: true });
    await prepsSettled();

    const [ws] = await db.select().from(reviewWorkspaces);
    expect(ws?.openedBy).toBe("review-prep");
    expect(await prepOf(ref)).toMatchObject({
      state: "needs-go-ahead",
      note: "It's a large PR. Run the checks from its review workspace.",
    });
    expect(await attention()).toEqual([
      expect.objectContaining({
        category: "review",
        kind: "action",
        title: "Review prep needs your go-ahead",
        body: "r#1: It's a large PR. Run the checks from its review workspace.",
        navTarget: expect.objectContaining({ type: "review-workspace", workspaceId: ws?.id }),
      }),
    ]);
    expect(await db.select().from(agentRuns)).toHaveLength(0);
  });

  it("waits for the checks to end, then raises the verdict, must-reads and review time", async () => {
    await heldChecks();
    expect(await prepReview(db, config, ref, prepDeps)).toMatchObject({
      status: "queued",
      createdWorkspace: false,
    });
    await until(async () => (await prepOf(ref))?.state === "verifying", "the prep to join");
    expect(await attention()).toEqual([]);

    release();
    await prepsSettled();
    const prep = await prepOf(ref);
    expect(prep).toMatchObject({ state: "ready", verdict: "review-deeper", risk: "low" });
    expect(prep?.headSha).toBeTruthy();
    const items = await prepItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "action",
      category: "review",
      title: "Ready for review",
      risk: "low",
    });
    const body = items[0]?.body ?? "";
    expect(body).toStartWith("r#1: Feature work\nVerdict: Review deeper first (1 medium finding).");
    expect(body).toContain("Must read: src/a.ts.");
    expect(body).toMatch(/Estimated review time: about \d/);
    expect(body).toContain("Its setup script hasn't run");
    // The user opened that workspace, so review prep doesn't claim it.
    const [ws] = await db.select().from(reviewWorkspaces);
    expect(ws?.openedBy).toBe("user");
  });

  it("raises a failed item, with the reason, when the checks fail", async () => {
    if (!kickoff.verification.run) throw new Error("unreachable");
    kickoff.verification.run.program = failingProgram;
    await heldChecks();
    await prepReview(db, config, ref, prepDeps);
    await until(async () => (await prepOf(ref))?.state === "verifying", "the prep to join");
    release();
    await prepsSettled();

    const total = DEFAULT_SECTIONS.length;
    expect(await prepOf(ref)).toMatchObject({
      state: "failed",
      note: `${total} of ${total} checks didn't finish.`,
      risk: null,
    });
    expect(await prepItems()).toEqual([
      expect.objectContaining({
        kind: "action",
        title: "Review prep failed",
        risk: null,
        body: `r#1: ${total} of ${total} checks didn't finish.`,
      }),
    ]);
  });

  it("doesn't open a workspace for a repo the user never registered", async () => {
    kickoff.isRegistered = async () => false;
    expect(await prepReview(db, config, ref, prepDeps)).toEqual({
      status: "needs-go-ahead",
      pr: "r#1",
      reason: "unregistered-repo",
    });
    expect(await db.select().from(reviewWorkspaces)).toEqual([]);
    expect(await db.select().from(reviewPreps)).toEqual([]);
  });

  it("doesn't prepare a PR twice", async () => {
    await heldChecks();
    await prepReview(db, config, ref, prepDeps);
    expect(await prepReview(db, config, ref, prepDeps)).toMatchObject({
      status: "already-preparing",
    });
    release();
    await prepsSettled();
    expect(await prepReview(db, config, ref, prepDeps)).toMatchObject({
      status: "already-prepared",
      state: "ready",
    });
    expect(await db.select().from(reviewWorkspaces)).toHaveLength(1);
  });

  it("prepares a whole stack, in the workspace it opened for the stack", async () => {
    stack = [ref, ref2];
    expect(await prepReview(db, config, ref, prepDeps)).toMatchObject({
      status: "queued",
      createdWorkspace: true,
      stack: ["r#2"],
    });
    expect(await prepReview(db, config, ref2, prepDeps)).toMatchObject({
      status: expect.stringMatching(/^already-/),
    });
    await prepsSettled();
    const workspaces = await db.select().from(reviewWorkspaces);
    expect(workspaces).toHaveLength(1);
    const [one, two] = [await prepOf(ref), await prepOf(ref2)];
    expect(one?.workspaceId).toBe(workspaces[0]?.id ?? "");
    expect(two?.workspaceId).toBe(workspaces[0]?.id ?? "");
    // PR 2 has no branch on the test remote.
    expect(two).toMatchObject({ state: "failed", note: "Its checkout failed." });
  });

  it("verifies only as many PRs at once as the setting allows", async () => {
    maxConcurrent = 1;
    await heldChecks();
    await prepReview(db, config, ref, prepDeps);
    await prepReview(db, config, ref2, prepDeps);
    await until(async () => (await prepOf(ref))?.state === "verifying", "the first prep");
    expect((await prepOf(ref2))?.state).toBe("queued");

    release();
    await prepsSettled();
    expect((await prepOf(ref))?.state).toBe("ready");
    expect((await prepOf(ref2))?.state).toBe("failed");
  });
});

describe("a prep waiting its turn", () => {
  it("doesn't reopen a workspace the user closed while it waited", async () => {
    maxConcurrent = 1;
    await heldChecks();
    await prepReview(db, config, ref, prepDeps);
    await until(async () => (await prepOf(ref))?.state === "verifying", "the first prep");
    await prepReview(db, config, ref2, prepDeps);
    const waiting = await prepOf(ref2);
    expect(waiting?.state).toBe("queued");
    await db
      .update(reviewWorkspaces)
      .set({ status: "archived" })
      .where(eq(reviewWorkspaces.id, waiting?.workspaceId ?? ""));

    release();
    await prepsSettled();
    expect(await prepOf(ref2)).toMatchObject({
      state: "done",
      note: "Its review workspace was closed.",
    });
    expect(await db.select().from(reviewWorkspaces)).toHaveLength(2);
  });
});

describe("the attention item", () => {
  it("is one per PR, updated in place when the PR is prepared again", async () => {
    await prepReview(db, config, ref, prepDeps);
    await prepsSettled();
    // The user archived the workspace; the PR comes back later.
    await db.update(reviewWorkspaces).set({ status: "archived" });
    await db.update(reviewPreps).set({ state: "failed" }).where(eq(reviewPreps.refKey, "gh:o/r/1"));
    expect(await prepReview(db, config, ref, prepDeps)).toMatchObject({
      status: "queued",
      createdWorkspace: true,
    });
    await prepsSettled();
    expect(await attention()).toHaveLength(1);
  });
});

describe("the review stream", () => {
  /** PR 1 ends needing a go-ahead (a large PR), which holds its slot. */
  async function oneSlotHeld(): Promise<void> {
    maxReady = 1;
    await prepReview(db, config, ref, prepDeps);
    await prepsSettled();
    expect((await prepOf(ref))?.state).toBe("needs-go-ahead");
  }
  const releaseHeld = async () =>
    releasePrep(db, (await prepOf(ref))?.id ?? "", "Done.", { resolveItem: false });
  /** Started: anything past the backlog. PRs 2 to 4 have no branch, so they end failed. */
  const started = async (r: PrRef) =>
    ["queued", "verifying", "failed"].includes((await prepOf(r))?.state ?? "");

  it("backlogs PRs past the limit without opening a workspace, keeping each one's place", async () => {
    await oneSlotHeld();
    expect(await prepReview(db, config, ref2, prepDeps)).toEqual({
      status: "backlogged",
      pr: "r#2",
      position: 1,
    });
    const first = await prepOf(ref2);
    expect(await prepReview(db, config, ref3, prepDeps)).toMatchObject({ position: 2 });
    expect(await prepReview(db, config, ref2, prepDeps)).toMatchObject({
      status: "backlogged",
      position: 1,
    });
    const again = await prepOf(ref2);
    expect(again).toMatchObject({ state: "backlog", workspaceId: null });
    expect(again?.backloggedAt).toEqual(first?.backloggedAt ?? null);
    expect(
      await db.select().from(reviewPreps).where(eq(reviewPreps.refKey, "gh:o/r/2")),
    ).toHaveLength(1);
    expect(await db.select().from(reviewWorkspaces)).toHaveLength(1);
    expect(await startBackloggedPreps(db, config, prepDeps)).toEqual({ started: 0, dropped: 0 });
  });

  it("starts the oldest backlogged PR first", async () => {
    await oneSlotHeld();
    await prepReview(db, config, ref3, prepDeps);
    await prepReview(db, config, ref2, prepDeps);
    await releaseHeld();
    expect(await startBackloggedPreps(db, config, prepDeps)).toEqual({ started: 1, dropped: 0 });
    expect(await started(ref3)).toBe(true);
    await prepsSettled();
    // PR 3's checkout failed, which freed its slot for PR 2 without a pass or the job.
    expect((await prepOf(ref2))?.state).toBe("failed");
  });

  it("frees a slot when the user dismisses a prepared PR's item, and starts the next", async () => {
    await oneSlotHeld();
    await prepReview(db, config, ref2, prepDeps);
    const stop = watchPrepDismissals(db, config, () => prepDeps);
    try {
      const [item] = await prepItems();
      const row = await updateAttentionStatus(db, item?.id ?? "", "dismissed");
      if (row) publish(row);
      await until(() => started(ref2), "PR 2 to start");
    } finally {
      stop();
    }
    await prepsSettled();
    expect(await prepOf(ref)).toMatchObject({ state: "released", note: "You dismissed it." });
  });

  it("keeps the slot when the item is only read, and ignores other items", async () => {
    await oneSlotHeld();
    await prepReview(db, config, ref2, prepDeps);
    const stop = watchPrepDismissals(db, config, () => prepDeps);
    try {
      const [item] = await prepItems();
      const read = await updateAttentionStatus(db, item?.id ?? "", "read");
      if (read) publish(read);
      const other = await raiseAttention(db, {
        category: "review",
        kind: "action",
        title: "Something else",
        dedupeKey: "other:gh:o/r/1",
      });
      const dismissed = await updateAttentionStatus(db, other.id, "dismissed");
      if (dismissed) publish(dismissed);
      // The watcher filters synchronously, so nothing it would start is pending.
      await prepsSettled();
    } finally {
      stop();
    }
    expect((await prepOf(ref))?.state).toBe("needs-go-ahead");
    expect((await prepOf(ref2))?.state).toBe("backlog");
  });

  it("doesn't count a failed prep against the limit", async () => {
    maxReady = 1;
    await prepReview(db, config, ref2, prepDeps);
    await prepsSettled();
    expect((await prepOf(ref2))?.state).toBe("failed");
    expect(await prepReview(db, config, ref, prepDeps)).toMatchObject({ status: "queued" });
    await prepsSettled();
  });

  it("lets a stack go past the limit, and starts nothing else until usage drops below it", async () => {
    maxReady = 2;
    stack = [ref, ref2, ref3];
    expect(await prepReview(db, config, ref, prepDeps)).toMatchObject({
      status: "queued",
      stack: ["r#2", "r#3"],
    });
    expect(await slotsInUse(db)).toBe(3);
    expect(await prepReview(db, config, ref4, prepDeps)).toMatchObject({ status: "backlogged" });
    // Only the PR asked for counts toward a heads-down pass's prep limit.
    expect((await prepOf(ref))?.requestedAt).toBeTruthy();
    expect((await prepOf(ref2))?.requestedAt).toBeNull();
    // Layers 2 and 3 fail their checkout, which brings usage to 1 of 2.
    await prepsSettled();
    expect((await prepOf(ref))?.state).toBe("needs-go-ahead");
    expect((await prepOf(ref4))?.state).toBe("failed");
  });

  it("skips layers the user is done with or that don't need their review", async () => {
    stack = [ref, ref2, ref3, ref4];
    await db.insert(reviewPreps).values({
      refKey: "gh:o/r/3",
      ref: ref3,
      state: "done",
      attentionKey: prepAttentionKey("gh:o/r/3"),
    });
    prepDeps.notNeedingReview = async () => new Set(["gh:o/r/2"]);
    expect(await prepReview(db, config, ref, prepDeps)).toMatchObject({
      status: "queued",
      stack: ["r#4"],
    });
    await prepsSettled();
    expect(await prepOf(ref2)).toBeUndefined();
    expect((await prepOf(ref3))?.state).toBe("done");
  });

  it("starts a backlogged stack whole, taking its other backlogged layers with it", async () => {
    await oneSlotHeld();
    stack = [ref2, ref3];
    await prepReview(db, config, ref3, prepDeps);
    await prepReview(db, config, ref2, prepDeps);
    await releaseHeld();

    expect(await startBackloggedPreps(db, config, prepDeps)).toEqual({ started: 1, dropped: 0 });
    expect(await started(ref3)).toBe(true);
    expect(await started(ref2)).toBe(true);
    await prepsSettled();
    const [two, three] = [await prepOf(ref2), await prepOf(ref3)];
    expect(two?.workspaceId).toBe(three?.workspaceId ?? "");
  });

  it("puts a new pick behind older backlogged PRs even when a slot is free", async () => {
    await oneSlotHeld();
    await prepReview(db, config, ref2, prepDeps);
    maxReady = 5;
    expect(await prepReview(db, config, ref3, prepDeps)).toMatchObject({
      status: "backlogged",
      position: 2,
    });
    await prepsSettled();
    expect(await started(ref2)).toBe(true);
    expect(await started(ref3)).toBe(true);
  });

  it("starts one PR at a time when two arrive at once", async () => {
    maxReady = 1;
    const results = await Promise.all([
      prepReview(db, config, ref, prepDeps),
      prepReview(db, config, ref2, prepDeps),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["backlogged", "queued"]);
    await prepsSettled();
  });

  it("drops a backlogged PR that no longer needs the user's review", async () => {
    await oneSlotHeld();
    await prepReview(db, config, ref2, prepDeps);
    await releaseHeld();
    prepDeps.notNeedingReview = async () => new Set(["gh:o/r/2"]);

    expect(await startBackloggedPreps(db, config, prepDeps)).toEqual({ started: 0, dropped: 1 });
    expect(await prepOf(ref2)).toMatchObject({
      state: "done",
      note: "It no longer needed your review.",
    });
    expect(await db.select().from(reviewWorkspaces)).toHaveLength(1);
  });

  it("moves a PR that fails to start to the back, so it can't hold up the rest", async () => {
    await oneSlotHeld();
    await prepReview(db, config, ref2, prepDeps);
    await prepReview(db, config, ref3, prepDeps);
    await releaseHeld();
    kickoff.isRegistered = async (r) => {
      if (r.provider === "github" && r.number === 2) throw new Error("lookup failed");
      return true;
    };

    expect(await startBackloggedPreps(db, config, prepDeps)).toEqual({ started: 0, dropped: 0 });
    expect((await prepOf(ref2))?.state).toBe("backlog");
    expect(await startBackloggedPreps(db, config, prepDeps)).toEqual({ started: 1, dropped: 0 });
    expect(await started(ref3)).toBe(true);
    await prepsSettled();
  });
});

describe("needsNoReview", () => {
  const pr = (
    overrides: Partial<ReviewCandidate> = {},
    summary: Partial<ReviewCandidate["summary"]> = {},
  ) =>
    ({
      summary: {
        number: 1,
        title: "",
        url: "",
        owner: "o",
        repo: "r",
        author: "them",
        draft: false,
        state: "open",
        createdAt: "",
        updatedAt: "",
        ...summary,
      },
      merged: false,
      myReviewStates: [],
      approvals: 0,
      changesRequested: 0,
      reviewDecision: "review_required",
      changedLines: 1,
      changedFiles: 1,
      ...overrides,
    }) as ReviewCandidate;

  it("is true once a PR is merged, closed, approved, the user's own or reviewed by them", () => {
    expect(needsNoReview(pr({ merged: true }), "me")).toBe(true);
    expect(needsNoReview(pr({}, { state: "closed" }), "me")).toBe(true);
    expect(needsNoReview(pr({ reviewDecision: "approved" }), "me")).toBe(true);
    expect(needsNoReview(pr({}, { author: "me" }), "me")).toBe(true);
    expect(needsNoReview(pr({ myReviewStates: ["changes_requested"] }), "me")).toBe(true);
    expect(needsNoReview(pr({ myReviewStates: ["approved"] }), "me")).toBe(true);
    // Leaving comments is acting on the PR, as much as approving it.
    expect(needsNoReview(pr({ myReviewStates: ["commented"] }), "me")).toBe(true);
  });

  it("is false for an open PR waiting on the user, or one someone else only commented on", () => {
    expect(needsNoReview(pr(), "me")).toBe(false);
    expect(needsNoReview(pr({ reviewDecision: "review_required", approvals: 0 }), "me")).toBe(
      false,
    );
  });
});
