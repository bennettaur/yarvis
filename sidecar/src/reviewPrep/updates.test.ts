import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { ProcessSlots } from "../agentRuns/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, attentionItems, prUpdateWatches } from "../db/schema.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import { recordReviewMark } from "../pr/reviewMarks.ts";
import type { PrDetail, PrRef, ReviewThread } from "../pr/types.ts";
import { reviewGit } from "../reviewWorkspaces/git.ts";
import { backgroundSettled, type KickoffDeps } from "../reviewWorkspaces/kickoff.ts";
import {
  createReviewWorkspace,
  getReviewPr,
  type PrMeta,
  type ReviewDeps,
} from "../reviewWorkspaces/service.ts";
import { createTestRemote, type TestRemote } from "../reviewWorkspaces/testRepo.ts";
import { REPORT_SECTIONS, VERIFICATION_RUN_KIND } from "../reviewWorkspaces/verification.ts";
import {
  type ProviderHead,
  type PrUpdateDeps,
  prUpdatesSettled,
  runPrUpdateWatch,
} from "./updates.ts";

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
const meta: PrMeta = {
  title: "Feature work",
  author: "octocat",
  headRef: "feature",
  baseRef: "main",
  fromFork: true,
};

const thread = (over: Partial<ReviewThread>): ReviewThread => ({
  id: "t",
  path: "src/a.ts",
  line: 1,
  side: "RIGHT",
  isResolved: false,
  isOutdated: false,
  canReply: true,
  canResolve: true,
  canUnresolve: false,
  comments: [{ id: "c", author: "me", body: "Why 2?", createdAt: "2026-01-01T00:00:00Z" }],
  ...over,
});

let remote: TestRemote;
let deps: PrUpdateDeps;
let heads: Map<string, ProviderHead>;
let threads: ReviewThread[];
let clock: Date;

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A workspace holding PR 1, checked out, with a review recorded at its head. */
async function reviewedWorkspace(): Promise<{ workspaceId: string; prId: string; head: string }> {
  const ws = await createReviewWorkspace(
    db,
    config,
    { name: "r#1", refs: [ref], openedBy: "user" },
    deps.review,
  );
  const prId = ws.prs[0]?.id as string;
  await until(async () => {
    const pr = await getReviewPr(db, ws.id, prId);
    return pr.status === "ready" && pr.worktreeStatus === "ready";
  }, "the checkout");
  const pr = await getReviewPr(db, ws.id, prId);
  await recordReviewMark(db, { ref, headSha: pr.headSha as string, source: "review" });
  return { workspaceId: ws.id, prId, head: pr.headSha as string };
}

const later = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};
const items = () => db.select().from(attentionItems);

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, pr_review_marks, pr_update_watches, agent_runs, attention_items RESTART IDENTITY CASCADE`;
  config.workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-pr-updates-"));
  remote = createTestRemote();
  heads = new Map();
  threads = [];
  clock = new Date("2026-11-23T10:00:00Z");
  const review: ReviewDeps = {
    loadPr: async () => meta,
    remoteUrlFor: async () => remote.url,
    credentialsFor: () => undefined,
    setupScriptFor: async () => null,
    git: () => reviewGit({ allowFileProtocol: true }),
  };
  const kickoff: KickoffDeps = {
    review,
    verification: {
      loadDetail: async () => ({ reviewThreads: [], checks: [] }) as unknown as PrDetail,
      loadTickets: async () => ({ tickets: [], notes: [] }),
      settings: async () => ({
        maxBudgetUsd: 100,
        sections: Object.fromEntries(REPORT_SECTIONS.map((s) => [s, { model: "haiku" as const }])),
      }),
      run: {
        program: "/usr/bin/false",
        registry: new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 }),
        instance: "test",
        slots: new ProcessSlots(12),
      },
    },
    isRegistered: async () => true,
    pollMs: 25,
  };
  deps = {
    review,
    kickoff,
    providerHeads: async () => heads,
    loadDetail: async () => ({ reviewThreads: threads }),
    viewer: async () => ({ login: "me" }),
    prepConfig: async () => ({ maxConcurrentVerifications: 2 }),
    now: () => clock,
    settleMs: 10 * 60_000,
  };
});

afterEach(async () => {
  await prUpdatesSettled();
  await backgroundSettled();
  rmSync(config.workspacesRoot, { recursive: true, force: true });
  rmSync(remote.root, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

describe("runPrUpdateWatch", () => {
  it("waits for pushes to settle, then fetches them and raises one item on the Since last review tab", async () => {
    const { workspaceId, prId } = await reviewedWorkspace();
    const first = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: true, headSha: first });
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 1 });

    // A second push inside the settle time starts the wait over.
    later(5);
    const second = remote.pushToPr("src/b.ts", "export const b = 1;\n");
    heads.set("gh:o/r/1", { open: true, headSha: second });
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 1 });
    later(9);
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 1 });

    threads = [
      thread({ id: "1", path: "src/a.ts" }),
      thread({ id: "2", path: "README.md", isResolved: true }),
      thread({
        id: "3",
        path: "README.md",
        comments: [{ id: "x", author: "someone-else", body: "nit", createdAt: "" }],
      }),
    ];
    later(2);
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({
      started: ["gh:o/r/1"],
      settling: 0,
    });
    await prUpdatesSettled();

    expect((await getReviewPr(db, workspaceId, prId)).headSha).toBe(second);
    const raised = await items();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      kind: "action",
      category: "review",
      title: "PR updated since your review",
      navTarget: { type: "review-workspace", workspaceId, prId, tab: "since-review" },
    });
    expect(raised[0]?.body).toBe(
      [
        "r#1: Feature work",
        "2 new commits and 2 files changed since your review.",
        "Your threads: 1 of 2 touched by the new commits, 1 still open.",
      ].join("\n"),
    );

    // The same head isn't raised again.
    later(30);
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });
    expect(await items()).toHaveLength(1);
  });

  it("leaves alone a PR that is closed, unreviewed, or at the reviewed commit", async () => {
    const { head } = await reviewedWorkspace();
    heads.set("gh:o/r/1", { open: true, headSha: head });
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });

    const pushed = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: false, headSha: pushed });
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });

    await sql`TRUNCATE pr_review_marks`;
    heads.set("gh:o/r/1", { open: true, headSha: pushed });
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });
    expect(await db.select().from(prUpdateWatches)).toEqual([]);
  });

  it("re-runs the checks a report already has, and says when they need a go-ahead", async () => {
    await reviewedWorkspace();
    await db.insert(agentRuns).values({
      kind: VERIFICATION_RUN_KIND,
      targetKey: "gh:o/r/1",
      status: "succeeded",
      instance: "test",
      meta: { refKey: "gh:o/r/1", sections: ["summary"], format: 2 },
    });
    const pushed = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: true, headSha: pushed });
    await runPrUpdateWatch(db, config, deps);
    later(11);
    await runPrUpdateWatch(db, config, deps);
    await prUpdatesSettled();

    const [item] = await items();
    // The test PR carries a file over the size cap, so its checks wait for the user.
    expect(item?.body).toContain(
      "The verification checks weren't re-run: they need your go-ahead: It's a large PR.",
    );
  });
});
