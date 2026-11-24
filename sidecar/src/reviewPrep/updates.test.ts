import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { fakeClaude, fakePrinting, resultLine } from "../agentRuns/testSupport.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, attentionItems, prUpdateWatches } from "../db/schema.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import type { RereviewRunConfig } from "../pr/models.ts";
import { recordReviewMark } from "../pr/reviewMarks.ts";
import type { PrDetail, PrRef, ReviewThread } from "../pr/types.ts";
import { reviewGit } from "../reviewWorkspaces/git.ts";
import { backgroundSettled } from "../reviewWorkspaces/kickoff.ts";
import { REREVIEW_RUN_KIND } from "../reviewWorkspaces/rereview.ts";
import {
  createReviewWorkspace,
  getReviewPr,
  type PrMeta,
  type ReviewDeps,
} from "../reviewWorkspaces/service.ts";
import { createTestRemote, type TestRemote } from "../reviewWorkspaces/testRepo.ts";
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
let fakeDir: string;
let rereviewSettings: RereviewRunConfig;

/** What the fake "What's changed" agent answers: it leaves the open thread out, so the server adds it and overrules the verdict. */
const answer = {
  summary: "The author changed a.ts.",
  verdict: "ready_to_approve",
  verdictReason: "Looks done.",
  comments: [],
  newChanges: [],
};

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
  fakeDir = mkdtempSync(join(tmpdir(), "yarvis-pr-updates-fake-"));
  rereviewSettings = { model: "haiku", maxBudgetUsd: 100, autoStart: false };
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
  deps = {
    review,
    rereview: {
      loadDetail: async () =>
        ({
          title: meta.title,
          body: "Changes a.",
          author: meta.author,
          reviewThreads: threads,
          conversation: [],
        }) as unknown as PrDetail,
      viewer: async () => ({ login: "me" }),
      settings: async () => rereviewSettings,
      run: {
        program: fakePrinting(fakeDir, "claude", [resultLine({ structured_output: answer })]),
        registry: new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 }),
        instance: "test",
      },
    },
    providerHeads: async () => heads,
    now: () => clock,
    settleMs: 10 * 60_000,
  };
});

afterEach(async () => {
  await prUpdatesSettled();
  await backgroundSettled();
  rmSync(config.workspacesRoot, { recursive: true, force: true });
  rmSync(remote.root, { recursive: true, force: true });
  rmSync(fakeDir, { recursive: true, force: true });
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
        // The fake agent says ready but gives the open thread no verdict, so the server overrules it.
        "What's changed: needs another look.",
        "Your comments: 0 of 1 addressed or resolved, 1 still open.",
        "Other changes: 2 changes to read.",
      ].join("\n"),
    );
    const runs = await db.select().from(agentRuns);
    expect(runs.map((r) => [r.kind, r.status])).toEqual([[REREVIEW_RUN_KIND, "succeeded"]]);

    // The same head isn't raised again.
    later(30);
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });
    expect(await items()).toHaveLength(1);
  });

  it("leaves alone a closed PR", async () => {
    await reviewedWorkspace();
    const pushed = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: false, headSha: pushed });
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });
    expect(await db.select().from(prUpdateWatches)).toEqual([]);
  });

  it("leaves alone a PR the user hasn't reviewed", async () => {
    await reviewedWorkspace();
    await sql`TRUNCATE pr_review_marks`;
    const pushed = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: true, headSha: pushed });
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });
    later(11);
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });
  });

  it("leaves alone a PR at the commit the user reviewed", async () => {
    const { head } = await reviewedWorkspace();
    heads.set("gh:o/r/1", { open: true, headSha: head });
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });
    later(11);
    expect(await runPrUpdateWatch(db, config, deps)).toEqual({ started: [], settling: 0 });
  });

  it("alerts once when two instances run at the same time", async () => {
    await reviewedWorkspace();
    const pushed = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: true, headSha: pushed });
    await runPrUpdateWatch(db, config, deps);
    later(11);
    const [a, b] = await Promise.all([
      runPrUpdateWatch(db, config, deps),
      runPrUpdateWatch(db, config, deps),
    ]);
    expect([...a.started, ...b.started]).toEqual(["gh:o/r/1"]);
    await prUpdatesSettled();
    expect(await items()).toHaveLength(1);
    const [watch] = await db.select().from(prUpdateWatches);
    expect(watch).toMatchObject({ alertedHeadSha: pushed });
    expect(watch?.alertedAt).toBeInstanceOf(Date);
  });

  it("alerts again on a later push, updating the unread item", async () => {
    await reviewedWorkspace();
    const first = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: true, headSha: first });
    await runPrUpdateWatch(db, config, deps);
    later(11);
    await runPrUpdateWatch(db, config, deps);
    await prUpdatesSettled();

    const second = remote.pushToPr("src/b.ts", "export const b = 1;\n");
    heads.set("gh:o/r/1", { open: true, headSha: second });
    await runPrUpdateWatch(db, config, deps);
    later(11);
    expect((await runPrUpdateWatch(db, config, deps)).started).toEqual(["gh:o/r/1"]);
    await prUpdatesSettled();
    const raised = await items();
    expect(raised).toHaveLength(1);
    expect(raised[0]?.body).toContain("2 new commits and 2 files changed since your review.");
  });

  it("takes over a claim whose alert was never raised", async () => {
    await reviewedWorkspace();
    const pushed = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: true, headSha: pushed });
    await runPrUpdateWatch(db, config, deps);
    // Another instance claimed it an hour in, then stopped before raising anything.
    await db.update(prUpdateWatches).set({
      alertedHeadSha: pushed,
      alertingAt: new Date(clock.getTime() + 60 * 60_000),
    });
    later(90);
    expect((await runPrUpdateWatch(db, config, deps)).started).toEqual([]);
    later(120);
    expect((await runPrUpdateWatch(db, config, deps)).started).toEqual(["gh:o/r/1"]);
    await prUpdatesSettled();
    expect(await items()).toHaveLength(1);
  });

  it("asks for a go-ahead instead of running What's changed over its budget", async () => {
    await reviewedWorkspace();
    rereviewSettings = { ...rereviewSettings, maxBudgetUsd: 0 };
    threads = [thread({ id: "1", path: "src/a.ts" })];
    const pushed = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: true, headSha: pushed });
    await runPrUpdateWatch(db, config, deps);
    later(11);
    await runPrUpdateWatch(db, config, deps);
    await prUpdatesSettled();

    const [item] = await items();
    // Without an answer, the item falls back to the thread count.
    expect(item?.body).toContain("Your threads: 1 of 1 touched by the new commits, 1 still open.");
    expect(item?.body).toMatch(
      /What's changed didn't run: it needs your go-ahead, since it would cost about \$[\d.]+, over its \$0\.00 budget\./,
    );
    expect(await db.select().from(agentRuns)).toEqual([]);
  });

  /** Pushes to the reviewed PR and runs the watch until its alert is raised. */
  async function pushAndAlert(): Promise<void> {
    const pushed = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    heads.set("gh:o/r/1", { open: true, headSha: pushed });
    await runPrUpdateWatch(db, config, deps);
    later(11);
    await runPrUpdateWatch(db, config, deps);
    await prUpdatesSettled();
  }

  it("reuses a What's changed run that already covers the new commits", async () => {
    await reviewedWorkspace();
    threads = [thread({ id: "1", path: "src/a.ts" })];
    await pushAndAlert();
    // The claim is given back, as after a failed alert, so the same head is alerted again.
    await db.update(prUpdateWatches).set({ alertedHeadSha: null });
    later(5);
    expect((await runPrUpdateWatch(db, config, deps)).started).toEqual(["gh:o/r/1"]);
    await prUpdatesSettled();

    expect(await db.select().from(agentRuns)).toHaveLength(1);
    const [item] = await items();
    expect(item?.body).toContain("What's changed: needs another look.");
  });

  it("says so when too much changed for What's changed to read", async () => {
    await reviewedWorkspace();
    deps.rereview.readerBudgetBytes = 1;
    await pushAndAlert();

    const [item] = await items();
    expect(item?.body).toContain(
      "What's changed didn't run: there's too much to read at once. Read the changes in the Since last review tab.",
    );
    expect(await db.select().from(agentRuns)).toEqual([]);
  });

  it("still raises the item, with the thread count, when What's changed fails", async () => {
    await reviewedWorkspace();
    threads = [thread({ id: "1", path: "src/a.ts" })];
    const run = deps.rereview.run as NonNullable<typeof deps.rereview.run>;
    deps.rereview.run = { ...run, program: fakeClaude(fakeDir, "broken", "exit 1") };
    await pushAndAlert();

    const [item] = await items();
    expect(item?.body).toContain("Your threads: 1 of 1 touched by the new commits, 1 still open.");
    expect(item?.body).toContain("What's changed failed. See Settings → Diagnostics.");
  });
});
