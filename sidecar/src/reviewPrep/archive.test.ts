import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { raiseAttention } from "../attention/raise.ts";
import { updateAttentionStatus } from "../attention/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { attentionItems, reviewPreps, reviewWorkspacePrs, reviewWorkspaces } from "../db/schema.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import type { ReviewDeps } from "../reviewWorkspaces/service.ts";
import { reviewSessionFolder, reviewWorkspaceDir } from "../reviewWorkspaces/service.ts";
import { type ReviewPrepUpkeepDeps, runReviewPrepUpkeep } from "./archive.ts";
import { prepAttentionKey, prepsSettled } from "./service.ts";

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

const ref = (number: number): PrRef => ({ provider: "github", owner: "o", repo: "r", number });

let done: Set<string>;
let gitStatus: string;
let deps: ReviewPrepUpkeepDeps;

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, review_preps, agent_runs, mutation_runs, attention_items RESTART IDENTITY CASCADE`;
  config.workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-prep-archive-"));
  done = new Set();
  gitStatus = "";
  const review = {
    loadPr: async () => {
      throw new Error("not in these tests");
    },
    remoteUrlFor: async () => "",
    credentialsFor: () => undefined,
    setupScriptFor: async () => null,
    git: () => ({
      local: async () => ({ stdout: gitStatus, stderr: "", exitCode: 0 }),
    }),
  } as unknown as ReviewDeps;
  deps = {
    review,
    prep: {
      kickoff: {
        review,
        verification: {} as never,
        isRegistered: async () => true,
        pollMs: 10,
      },
    },
    donePrs: async () => done,
  };
  deps.prep.notNeedingReview = async () => done;
});

afterEach(async () => {
  await prepsSettled();
  rmSync(config.workspacesRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

/** A workspace holding `refs`, each prepared and its item raised. */
async function workspace(
  refs: PrRef[],
  openedBy: "user" | "review-prep" = "review-prep",
  options: { checkouts?: boolean } = {},
) {
  const [ws] = await db.insert(reviewWorkspaces).values({ name: "r#1", openedBy }).returning();
  if (!ws) throw new Error("no workspace");
  const prs = [];
  for (const [i, r] of refs.entries()) {
    const worktreePath = join(reviewWorkspaceDir(config, ws.id), `pr-${i}`);
    if (options.checkouts) mkdirSync(worktreePath, { recursive: true });
    const [pr] = await db
      .insert(reviewWorkspacePrs)
      .values({
        workspaceId: ws.id,
        refKey: refKey(r),
        ref: r,
        colorIndex: i,
        position: i,
        worktreePath,
        status: "ready",
        worktreeStatus: "ready",
      })
      .returning();
    if (!pr) throw new Error("no pr");
    prs.push(pr);
    await db.insert(reviewPreps).values({
      refKey: refKey(r),
      ref: r,
      workspaceId: ws.id,
      prId: pr.id,
      state: "ready",
      attentionKey: prepAttentionKey(refKey(r)),
    });
    await raiseAttention(db, {
      category: "review",
      kind: "action",
      title: "Ready for review",
      dedupeKey: prepAttentionKey(refKey(r)),
    });
  }
  return { ws, prs };
}

const pending = async () =>
  (await db.select().from(attentionItems)).filter((a) => a.status === "pending");

const statusOf = async (id: string) =>
  (await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, id)))[0]?.status;

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("runReviewPrepUpkeep", () => {
  it("archives a workspace review prep opened once every PR in it is done, and resolves its items", async () => {
    const { ws } = await workspace([ref(1), ref(2)]);
    done = new Set([refKey(ref(1)), refKey(ref(2))]);

    const result = await runReviewPrepUpkeep(db, config, deps);
    expect(result.archived).toEqual([ws.id]);
    await until(async () => (await statusOf(ws.id)) === "archived", "the archive");

    // The archive finishes in the background, so the run that started it may
    // already see it archived and resolve the items; otherwise the next run does.
    const next = await runReviewPrepUpkeep(db, config, deps);
    expect(result.resolved + next.resolved).toBe(2);
    expect(await pending()).toEqual([]);
    const preps = await db.select().from(reviewPreps);
    expect(preps.map((p) => p.state)).toEqual(["done", "done"]);
  });

  it("leaves it while any PR still waits on the user", async () => {
    const { ws } = await workspace([ref(1), ref(2)]);
    done = new Set([refKey(ref(1))]);
    const result = await runReviewPrepUpkeep(db, config, deps);
    expect(result).toMatchObject({ archived: [], released: 1 });
    expect(await statusOf(ws.id)).toBe("active");
    // PR 1's slot is freed and its item resolved; PR 2's still waits.
    expect((await pending()).map((a) => a.sessionKey)).toEqual([
      `raise:system:${prepAttentionKey(refKey(ref(2)))}`,
    ]);
    const states = await db.select().from(reviewPreps);
    expect(states.find((p) => p.refKey === refKey(ref(1)))?.state).toBe("released");
  });

  it("waits while a prep of one of its PRs is still running", async () => {
    const { ws } = await workspace([ref(1), ref(2)]);
    await db
      .update(reviewPreps)
      .set({ state: "verifying", updatedAt: new Date() })
      .where(eq(reviewPreps.refKey, refKey(ref(2))));
    done = new Set([refKey(ref(1)), refKey(ref(2))]);
    expect(await runReviewPrepUpkeep(db, config, deps)).toMatchObject({ archived: [], asked: [] });
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("never archives a workspace the user opened", async () => {
    const { ws } = await workspace([ref(1)], "user");
    done = new Set([refKey(ref(1))]);
    expect(await runReviewPrepUpkeep(db, config, deps)).toMatchObject({ archived: [], asked: [] });
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("leaves a workspace the user opened in the last few minutes for the next run", async () => {
    const { ws } = await workspace([ref(1)]);
    await db
      .update(reviewWorkspaces)
      .set({ lastOpenedAt: new Date() })
      .where(eq(reviewWorkspaces.id, ws.id));
    done = new Set([refKey(ref(1))]);
    expect((await runReviewPrepUpkeep(db, config, deps)).archived).toEqual([]);
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("asks instead when an Ask Claude session was started in it", async () => {
    const { ws, prs } = await workspace([ref(1)]);
    mkdirSync(reviewSessionFolder(config, ws.id), { recursive: true });
    done = new Set([refKey(ref(1))]);

    expect(await runReviewPrepUpkeep(db, config, deps)).toMatchObject({
      archived: [],
      asked: [ws.id],
    });
    expect(await statusOf(ws.id)).toBe("active");
    const ask = (await pending()).find((a) => a.title === "Review workspace ready to archive");
    expect(ask).toMatchObject({
      kind: "action",
      category: "review",
      body: "r#1: every PR in it is approved, merged or closed, but an Ask Claude session was started in it. Archive it from the Review tab when you're done with it.",
      navTarget: { type: "review-workspace", workspaceId: ws.id, prId: prs[0]?.id },
    });

    // Asking again on the next run updates the same item.
    await runReviewPrepUpkeep(db, config, deps);
    expect(
      (await pending()).filter((a) => a.title === "Review workspace ready to archive"),
    ).toHaveLength(1);
  });

  it("asks instead when a checkout has uncommitted changes", async () => {
    const { ws } = await workspace([ref(1)], "review-prep", { checkouts: true });
    gitStatus = " M src/app.ts\n";
    done = new Set([refKey(ref(1))]);
    expect((await runReviewPrepUpkeep(db, config, deps)).asked).toEqual([ws.id]);
    expect(await statusOf(ws.id)).toBe("active");
    expect((await pending()).map((a) => a.body)).toContain(
      "r#1: every PR in it is approved, merged or closed, but a checkout has uncommitted changes. Archive it from the Review tab when you're done with it.",
    );
  });

  it("resolves the ask and the PRs' items once the user archives it themselves", async () => {
    const { ws } = await workspace([ref(1)]);
    mkdirSync(reviewSessionFolder(config, ws.id), { recursive: true });
    done = new Set([refKey(ref(1))]);
    await runReviewPrepUpkeep(db, config, deps);
    expect((await pending()).map((a) => a.title)).toEqual(["Review workspace ready to archive"]);

    await db
      .update(reviewWorkspaces)
      .set({ status: "archived" })
      .where(eq(reviewWorkspaces.id, ws.id));
    await runReviewPrepUpkeep(db, config, deps);
    expect(await pending()).toEqual([]);
  });

  it("does nothing when GitHub can't be asked", async () => {
    const { ws } = await workspace([ref(1)]);
    deps.donePrs = async () => null;
    expect((await runReviewPrepUpkeep(db, config, deps)).archived).toEqual([]);
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("picks up a prep a restart left mid-way", async () => {
    const { prs } = await workspace([ref(1)]);
    await db.update(reviewWorkspacePrs).set({ status: "error" });
    await db
      .update(reviewPreps)
      .set({ state: "verifying", updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });

    expect((await runReviewPrepUpkeep(db, config, deps)).requeued).toBe(1);
    await prepsSettled();
    const [prep] = await db.select().from(reviewPreps);
    // Its checkout had failed, which the requeued prep reports.
    expect(prep).toMatchObject({ state: "failed", prId: prs[0]?.id });
    expect(prep?.note).toContain("the checkout failed");
  });
});

describe("the review stream's upkeep", () => {
  const backlog = async (r: PrRef, minutesAgo: number) =>
    db.insert(reviewPreps).values({
      refKey: refKey(r),
      ref: r,
      state: "backlog",
      backloggedAt: new Date(Date.now() - minutesAgo * 60_000),
      attentionKey: prepAttentionKey(refKey(r)),
    });
  const stateOf = async (r: PrRef) =>
    (
      await db
        .select()
        .from(reviewPreps)
        .where(eq(reviewPreps.refKey, refKey(r)))
    )[0]?.state;

  beforeEach(() => {
    deps.prep.prepConfig = async () => ({ maxConcurrentVerifications: 1, maxReady: 1 });
  });

  it("frees the slot of a PR whose item the user dismissed, and takes up the backlog", async () => {
    await workspace([ref(1)], "user");
    await backlog(ref(2), 10);
    const [item] = await pending();
    await updateAttentionStatus(db, item?.id ?? "", "dismissed");
    // No workspace can be opened in this test, so the backlogged PR's repo is
    // unregistered and it leaves the backlog rather than starting.
    deps.prep.kickoff.isRegistered = async () => false;

    const result = await runReviewPrepUpkeep(db, config, deps);
    expect(result.released).toBe(1);
    expect(await stateOf(ref(1))).toBe("released");
    const [backlogged] = await db
      .select()
      .from(reviewPreps)
      .where(eq(reviewPreps.refKey, refKey(ref(2))));
    expect(backlogged).toMatchObject({ state: "done", note: "Its repo is no longer registered." });
  });

  it("keeps the backlog while every slot is in use", async () => {
    await workspace([ref(1)], "user");
    await backlog(ref(2), 10);
    expect(await runReviewPrepUpkeep(db, config, deps)).toMatchObject({ released: 0, started: 0 });
    expect(await stateOf(ref(2))).toBe("backlog");
  });

  it("drops backlogged PRs that no longer need the user's review", async () => {
    await workspace([ref(1)], "user");
    await backlog(ref(2), 10);
    await backlog(ref(3), 5);
    deps.prep.notNeedingReview = async (refs) =>
      new Set(refs.map(refKey).filter((k) => k === refKey(ref(3))));
    expect((await runReviewPrepUpkeep(db, config, deps)).dropped).toBe(1);
    expect(await stateOf(ref(2))).toBe("backlog");
    expect(await stateOf(ref(3))).toBe("done");
  });

  it("never marks a backlogged PR done for having no workspace", async () => {
    await backlog(ref(2), 10);
    deps.prep.prepConfig = async () => ({ maxConcurrentVerifications: 1, maxReady: 0 });
    await runReviewPrepUpkeep(db, config, deps);
    expect(await stateOf(ref(2))).toBe("backlog");
  });

  it("frees the slot of a PR the user reviewed, and resolves its item", async () => {
    await workspace([ref(1)], "user");
    done = new Set([refKey(ref(1))]);
    expect((await runReviewPrepUpkeep(db, config, deps)).released).toBe(1);
    expect(await stateOf(ref(1))).toBe("released");
    expect(await pending()).toEqual([]);
  });

  it("doesn't release a prep for a dismissal from before it last changed", async () => {
    await workspace([ref(1)], "user");
    const [item] = await pending();
    await updateAttentionStatus(db, item?.id ?? "", "dismissed");
    // Prepared again since: the old round's dismissal says nothing about this one.
    await db
      .update(reviewPreps)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(reviewPreps.refKey, refKey(ref(1))));
    expect((await runReviewPrepUpkeep(db, config, deps)).released).toBe(0);
    expect(await stateOf(ref(1))).toBe("ready");
  });
});
