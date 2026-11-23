import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { ProcessSlots } from "../agentRuns/service.ts";
import { fakeClaude } from "../agentRuns/testSupport.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, attentionItems, reviewPreps, reviewWorkspaces } from "../db/schema.ts";
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
import { prepReview, prepsSettled, type ReviewPrepDeps, withVerificationSlot } from "./service.ts";

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
  prepDeps = {
    kickoff,
    loadStack: async () => stack,
    prepConfig: async () => ({ maxConcurrentVerifications: maxConcurrent }),
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
    expect(prep).toMatchObject({ state: "ready", verdict: "review-deeper" });
    expect(prep?.headSha).toBeTruthy();
    const items = await prepItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "action",
      category: "review",
      title: "Ready for review",
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
    });
    expect(await prepItems()).toEqual([
      expect.objectContaining({
        kind: "action",
        title: "Review prep failed",
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

  it("puts a stack's layers in the workspace it opened for the stack", async () => {
    stack = [ref, ref2];
    await prepReview(db, config, ref, prepDeps);
    expect(await prepReview(db, config, ref2, prepDeps)).toMatchObject({
      status: "queued",
      createdWorkspace: false,
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

describe("withVerificationSlot", () => {
  it("holds work outside the queue to the same limit, and frees the slot when it throws", async () => {
    let checks = 0;
    const one = async () => {
      checks++;
      return { maxConcurrentVerifications: 1 };
    };
    let failFirst = (_e: Error) => {};
    const first = withVerificationSlot(
      () =>
        new Promise<void>((_resolve, reject) => {
          failFirst = reject;
        }),
      one,
    );
    let secondRan = false;
    const second = withVerificationSlot(async () => {
      secondRan = true;
    }, one);
    await until(async () => checks >= 2, "the second call to find no free slot");
    expect(secondRan).toBe(false);
    failFirst(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await second;
    expect(secondRan).toBe(true);
  });
});
