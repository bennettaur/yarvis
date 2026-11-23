import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { ProcessSlots } from "../agentRuns/service.ts";
import { fakeClaude } from "../agentRuns/testSupport.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, attentionItems, reviewWorkspacePrs } from "../db/schema.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import type { RunChoice } from "../pr/models.ts";
import { buildPrReviewStartTools } from "../pr/startReviewTools.ts";
import type { PrDetail, PrRef } from "../pr/types.ts";
import { printAgentAnswer, writeAgentAnswers } from "./fakeAgents.ts";
import { reviewGit } from "./git.ts";
import { backgroundSettled, type KickoffDeps, kickOffVerification } from "./kickoff.ts";
import { cancelVerificationQueue, getVerificationQueue, startVerificationQueue } from "./queue.ts";
import type { PrMeta, ReviewDeps } from "./service.ts";
import { createTestRemote, type TestRemote } from "./testRepo.ts";
import { DEFAULT_SECTIONS, REPORT_SECTIONS, type ReportSection } from "./verification.ts";

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
const pass = { status: "pass", findings: [] };
const report = {
  summary: "A small change.",
  mustRead: [],
  changeMap: { intent: "A small change.", themes: [] },
  claims: { items: [], gaps: [] },
  risk: { level: "low", clientImpact: "None.", mitigations: [], concerns: [] },
  tests: pass,
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
let checkoutFails: boolean;
/** While set, the PR's checkout waits on it, so a test can hold the clone open. */
let checkoutGate: Promise<void> | null;
let failingProgram: string;
let kickoff: KickoffDeps;

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const release = () => writeFileSync(join(fakeDir, "release"), "");

const attention = () => db.select().from(attentionItems);

/**
 * The test PR is large, so the go-ahead bell is the first sign its checkout
 * finished. Any bell would also match one left over from another test.
 */
const goAheadBellRung = async () => (await attention()).some((a) => a.title.includes("go-ahead"));

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, agent_runs, attention_items RESTART IDENTITY CASCADE`;
  config.workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-kickoff-root-"));
  remote = createTestRemote();
  checkoutFails = false;
  checkoutGate = null;
  fakeDir = mkdtempSync(join(tmpdir(), "yarvis-kickoff-fake-"));
  writeAgentAnswers(fakeDir, report);
  // Holds the run open until the test releases it, then hands in its agent's answer.
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
echo "agent blew up reading the PR" >&2
exit 1`,
  );
  const inner = reviewGit({ allowFileProtocol: true });
  const review: ReviewDeps = {
    loadPr: async () => meta,
    remoteUrlFor: async () => remote.url,
    credentialsFor: () => undefined,
    setupScriptFor: async () => null,
    git: () => ({
      ...inner,
      local: async (args, opts) => {
        if (args[0] === "checkout" && checkoutGate) await checkoutGate;
        return args[0] === "checkout" && checkoutFails
          ? { stdout: "", stderr: "checkout exploded", exitCode: 1 }
          : inner.local(args, opts);
      },
    }),
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
        // Its own, so a fake a test leaves running can't hold another test's slot.
        slots: new ProcessSlots(12),
      },
    },
    isRegistered: async () => true,
    pollMs: 25,
  };
});

// A bell or poll from a test that has ended would land in the next one's tables.
afterEach(async () => {
  release();
  await backgroundSettled();
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(config.workspacesRoot, { recursive: true, force: true });
  rmSync(remote.root, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

describe("kickOffVerification", () => {
  it("creates a review workspace, waits for its checkout, and asks before a large PR", async () => {
    const first = await kickOffVerification(db, config, ref, {}, kickoff);
    expect(first).toMatchObject({ status: "waiting-for-checkout", createdWorkspace: true });
    if (first.status !== "waiting-for-checkout") throw new Error("unreachable");

    // The test remote's PR is past the large-PR line, so the background start
    // asks for a go-ahead rather than spending on it.
    await until(goAheadBellRung, "the go-ahead notice");
    const [notice] = await attention();
    expect(notice?.navTarget).toEqual({
      type: "review-workspace",
      workspaceId: first.workspaceId,
      prId: first.prId,
      tab: "verification",
    });
    expect(notice?.body).toStartWith("Feature work:");
    const [ws] = await sql`SELECT name FROM review_workspaces`;
    expect(ws?.name).toBe("r#1");
    expect(await db.select().from(agentRuns)).toHaveLength(0);

    // Asking again finds the same workspace instead of making a second one.
    expect(notice?.body).toContain("It's a large PR");
    const again = await kickOffVerification(db, config, ref, {}, kickoff);
    expect(again).toMatchObject({
      status: "needs-confirmation",
      reason: "large",
      workspaceId: first.workspaceId,
      prId: first.prId,
      size: { large: true },
    });
    // Counts only: the file lists name paths the PR's author chose.
    expect(again).not.toHaveProperty("size.binary");
    expect(again).not.toHaveProperty("size.skimmed");
  });

  it("asks before a PR whose size couldn't be worked out", async () => {
    kickoff.verification.settings = async () => {
      throw new Error("settings unreadable");
    };
    await kickOffVerification(db, config, ref, {}, kickoff);
    await until(goAheadBellRung, "the go-ahead notice");
    const [notice] = await attention();
    expect(notice?.body).toContain("Its size couldn't be worked out");
    expect(await kickOffVerification(db, config, ref, {}, kickoff)).toMatchObject({
      status: "needs-confirmation",
      reason: "unsized",
      size: null,
    });
  });

  it("starts once confirmed, joins the running checks, and rings the bell when they all end", async () => {
    await kickOffVerification(db, config, ref, {}, kickoff);
    await until(goAheadBellRung, "the checkout");
    await sql`TRUNCATE attention_items`;

    const started = await kickOffVerification(db, config, ref, { confirmed: true }, kickoff);
    expect(started).toMatchObject({ status: "started" });
    if (started.status !== "started") throw new Error("unreachable");

    // One run per default section.
    expect(started.runIds).toHaveLength(DEFAULT_SECTIONS.length);
    // Confirming again doesn't start a second run of any of them.
    expect(started.sections).toEqual({
      started: [...DEFAULT_SECTIONS],
      running: [],
      current: [],
      failed: [],
    });
    const joined = await kickOffVerification(db, config, ref, { confirmed: true }, kickoff);
    expect(joined).toEqual({
      ...started,
      status: "already-running",
      sections: { started: [], running: [...DEFAULT_SECTIONS], current: [], failed: [] },
    });

    release();
    await until(
      async () => (await attention()).some((a) => a.title === "Verification report ready"),
      "the ready notice",
    );
    const runs = await db.select().from(agentRuns).where(inArray(agentRuns.id, started.runIds));
    expect(runs.map((r) => r.status)).toEqual(started.runIds.map(() => "succeeded"));
    expect(await db.select().from(agentRuns)).toHaveLength(DEFAULT_SECTIONS.length);
    // One notice once every run has ended, though the report was asked for twice.
    const ready = (await attention()).filter((a) => a.title === "Verification report ready");
    expect(ready).toHaveLength(1);

    // A report for the current head is kept unless a re-run is asked for.
    expect(await kickOffVerification(db, config, ref, { confirmed: true }, kickoff)).toEqual({
      ...started,
      status: "exists",
      sections: { started: [], running: [], current: [...DEFAULT_SECTIONS], failed: [] },
    });

    // Asking for a current section and a new one starts only the new one.
    const more = await kickOffVerification(
      db,
      config,
      ref,
      { confirmed: true, sections: ["tests", "flow"] },
      kickoff,
    );
    expect(more).toMatchObject({
      status: "started",
      sections: { started: ["flow"], running: [], current: ["tests"], failed: [] },
    });
    await until(async () => {
      const rows = await db.select().from(agentRuns);
      return (
        rows.length === DEFAULT_SECTIONS.length + 1 && rows.every((r) => r.status !== "running")
      );
    }, "the flow run");

    // A re-run starts a section even with a current result.
    const again = await kickOffVerification(
      db,
      config,
      ref,
      { confirmed: true, rerun: true, sections: ["tests"] },
      kickoff,
    );
    expect(again).toMatchObject({
      status: "started",
      sections: { started: ["tests"], current: [] },
    });
    await until(
      async () => (await db.select().from(agentRuns)).every((r) => r.status !== "running"),
      "the re-run",
    );
  });

  // Through the tool, so the arguments the model sends are the ones that count.
  it("asks before cloning a repo the user never registered, then still asks about cost", async () => {
    kickoff.isRegistered = async () => false;
    const tools = buildPrReviewStartTools(db, config, { kickoff: () => kickoff });
    const start = (input: unknown) =>
      (
        tools.start_pr_verification_report as unknown as {
          execute: (i: unknown, o: unknown) => Promise<unknown>;
        }
      ).execute(input, { toolCallId: "t", messages: [] });
    const pullRequest = { provider: "github", owner: "o", repo: "r", number: 1 };

    expect(await start({ pullRequest })).toEqual({
      status: "needs-confirmation",
      reason: "unregistered-repo",
      workspaceId: null,
      prId: null,
      size: null,
    });
    expect(await sql`SELECT id FROM review_workspaces`).toHaveLength(0);

    const confirmed = await start({ pullRequest, confirmed: true });
    expect(confirmed).toMatchObject({ status: "waiting-for-checkout", createdWorkspace: true });
    // The yes was to the repo. Nobody has seen this large PR's cost, so the
    // clone finishing asks again rather than starting.
    await until(goAheadBellRung, "the go-ahead notice");
    expect(await db.select().from(agentRuns)).toHaveLength(0);
  });

  it("runs every check on the model and effort the assistant named", async () => {
    await kickOffVerification(db, config, ref, {}, kickoff);
    await until(goAheadBellRung, "the checkout");
    const tools = buildPrReviewStartTools(db, config, { kickoff: () => kickoff });
    const started = await (
      tools.start_pr_verification_report as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute(
      {
        pullRequest: { provider: "github", owner: "o", repo: "r", number: 1 },
        sections: ["tests"],
        confirmed: true,
        model: "opus",
        effort: "max",
      },
      { toolCallId: "t", messages: [] },
    );
    expect(started).toMatchObject({ status: "started" });
    const [row] = await db.select().from(agentRuns);
    expect(row?.meta).toMatchObject({ model: "opus", effort: "max" });
    release();
    await until(
      async () => (await db.select().from(agentRuns)).every((r) => r.status !== "running"),
      "the run",
    );
  });

  it("rings an error bell, without the run's own error, when the report fails", async () => {
    if (kickoff.verification.run) kickoff.verification.run.program = failingProgram;
    await kickOffVerification(db, config, ref, {}, kickoff);
    await until(goAheadBellRung, "the checkout");
    await sql`TRUNCATE attention_items`;

    expect(await kickOffVerification(db, config, ref, { confirmed: true }, kickoff)).toMatchObject({
      status: "started",
    });
    release();
    await until(
      async () => (await attention()).some((a) => a.title === "Verification report failed"),
      "the failure notice",
    );
    const items = await attention();
    expect(items.map((a) => a.title)).toEqual(["Verification report failed"]);
    expect(items[0]?.kind).toBe("error");
    expect(items[0]?.body).not.toContain("blew up");
  });

  it("rings one error bell, not ready, when one check of several fails", async () => {
    // Fails only the run writing the test-quality section.
    const program = fakeClaude(
      fakeDir,
      "claude-tests-fail",
      `input=$(cat)
while [ -d "${fakeDir}" ] && [ ! -f "${fakeDir}/release" ]; do sleep 0.02; done
case "$*" in *"yarvis-review:test-reviewer"*) echo "tests agent blew up" >&2; exit 1;; esac
${printAgentAnswer(fakeDir)}`,
    );
    if (kickoff.verification.run) kickoff.verification.run.program = program;
    await kickOffVerification(db, config, ref, {}, kickoff);
    await until(goAheadBellRung, "the checkout");
    await sql`TRUNCATE attention_items`;

    expect(await kickOffVerification(db, config, ref, { confirmed: true }, kickoff)).toMatchObject({
      status: "started",
    });
    release();
    await until(
      async () => (await attention()).some((a) => a.title === "Verification report failed"),
      "the failure notice",
    );
    const items = await attention();
    expect(items.map((a) => a.title)).toEqual(["Verification report failed"]);
    expect(items[0]?.body).toContain(`1 of the ${DEFAULT_SECTIONS.length} checks failed`);
    const runs = await db.select().from(agentRuns);
    expect(runs.filter((r) => r.status === "failed")).toHaveLength(1);
  });

  it("prices the go-ahead for the sections about to run, leaving out current ones", async () => {
    await kickOffVerification(db, config, ref, {}, kickoff);
    await until(goAheadBellRung, "the checkout");
    const cost = async (sections: ReportSection[], override?: RunChoice) => {
      const asked = await kickOffVerification(db, config, ref, { sections, override }, kickoff);
      if (asked.status !== "needs-confirmation" || !asked.size)
        throw new Error("expected a go-ahead");
      return asked.size.estimatedCostUsd;
    };
    const one = await cost(["tests"]);
    expect(one).toBeGreaterThan(0);
    expect(await cost(["tests", "risk"])).toBeGreaterThan(one);
    // The settings run everything on Haiku; a run on another model is priced at that model.
    const onSonnet = await cost(["tests"], { model: "sonnet" });
    expect(onSonnet).toBeGreaterThan(one);
    expect(await cost(["tests"], { model: "opus" })).toBeGreaterThan(onSonnet);

    // Once the test-quality check has a result for this head, it isn't priced again.
    await kickOffVerification(db, config, ref, { confirmed: true, sections: ["tests"] }, kickoff);
    release();
    await until(async () => {
      const rows = await db.select().from(agentRuns);
      return rows.length === 1 && rows[0]?.status === "succeeded";
    }, "the tests run");
    expect(await cost(["tests", "risk"])).toBe(await cost(["risk"]));
    expect(await cost(["risk"])).toBe(one);
  });

  it("says so when the checkout doesn't finish in time", async () => {
    const { promise, resolve: openCheckout } = Promise.withResolvers<void>();
    checkoutGate = promise;
    kickoff.waitMs = 1;
    const first = await kickOffVerification(db, config, ref, {}, kickoff);
    expect(first.status).toBe("waiting-for-checkout");
    await until(
      async () => (await attention()).some((a) => a.kind === "error"),
      "the timeout notice",
    );
    const [notice] = await attention();
    expect(notice?.title).toBe("Verification report not started");
    expect(notice?.body).toContain("The checkout didn't finish");

    // Let the clone finish, so it doesn't write into the next test.
    openCheckout();
    await until(async () => {
      const [pr] = await db.select().from(reviewWorkspacePrs);
      return pr?.worktreeStatus === "ready" || pr?.worktreeStatus === "error";
    }, "the checkout to settle");
  });

  it("shares one workspace between two asks made at once", async () => {
    const [a, b] = await Promise.all([
      kickOffVerification(db, config, ref, {}, kickoff),
      kickOffVerification(db, config, ref, {}, kickoff),
    ]);
    expect(a).toMatchObject({ status: "waiting-for-checkout", createdWorkspace: true });
    expect(b).toMatchObject({ status: "waiting-for-checkout", createdWorkspace: false });
    expect(await sql`SELECT id FROM review_workspaces`).toHaveLength(1);
    await until(goAheadBellRung, "the go-ahead notice");
    // One waiter, so one notice.
    expect(await attention()).toHaveLength(1);
  });

  it("says so when the checkout fails", async () => {
    checkoutFails = true;
    const first = await kickOffVerification(db, config, ref, {}, kickoff);
    expect(first.status).toBe("waiting-for-checkout");
    await until(
      async () => (await attention()).some((a) => a.kind === "error"),
      "the failure notice",
    );
    const [notice] = await attention();
    expect(notice?.title).toBe("Verification report not started");

    const again = await kickOffVerification(db, config, ref, {}, kickoff);
    expect(again.status).toBe("error");
    // The model gets a fixed message; git's output stays in the bell and the log.
    expect(again).not.toHaveProperty("error", expect.stringContaining("exploded"));
    const [pr] = await db.select().from(reviewWorkspacePrs);
    expect(pr?.worktreeStatus).toBe("error");
  });
});

describe("startVerificationQueue", () => {
  const ref2: PrRef = { ...ref, number: 2 };
  const queueBell = async () =>
    (await attention()).find((a) => a.title.startsWith("Verification queue"));

  /** PR 1 checked out, with its summary check started and held open by the fake. */
  async function heldRun() {
    await kickOffVerification(db, config, ref, {}, kickoff);
    await until(goAheadBellRung, "the checkout");
    await sql`TRUNCATE attention_items`;
    const started = await kickOffVerification(
      db,
      config,
      ref,
      { confirmed: true, sections: ["summary"] },
      kickoff,
    );
    expect(started).toMatchObject({ status: "started" });
  }

  it("keeps the model and effort the assistant named for every PR it checks", async () => {
    const tools = buildPrReviewStartTools(db, config, { kickoff: () => kickoff });
    const answer = (await (
      tools.start_pr_verification_queue as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute(
      {
        pullRequests: [{ provider: "github", owner: "o", repo: "r", number: 1 }],
        preset: "quick",
        model: "haiku",
        effort: "low",
      },
      { toolCallId: "t", messages: [] },
    )) as { queueId: string };
    expect(getVerificationQueue(answer.queueId)?.override).toEqual({
      model: "haiku",
      effort: "low",
    });
    await until(async () => (await queueBell()) !== undefined, "the queue's bell");
  });

  it("skips a PR that needs the user's go-ahead, and rings one bell naming it", async () => {
    const { queue } = startVerificationQueue(db, config, [ref], ["summary"], kickoff);
    expect(queue.items).toEqual([{ ref, name: "r#1", state: "running", note: null }]);
    await until(async () => (await queueBell()) !== undefined, "the queue's bell");
    expect(getVerificationQueue(queue.id)).toMatchObject({
      finished: true,
      items: [{ state: "needs-confirmation", note: "It's a large PR." }],
    });
    // The PR's own go-ahead bell stays quiet: the queue reports for it.
    expect(await attention()).toEqual([
      expect.objectContaining({
        kind: "info",
        title: "Verification queue finished: 0 of 1 checked",
        body: "r#1: needs your go-ahead. It's a large PR.",
      }),
    ]);
    expect(await db.select().from(agentRuns)).toHaveLength(0);
  });

  it("starts the next PR only once the last one's checks end, and runs one queue at a time", async () => {
    await heldRun();
    const { queue } = startVerificationQueue(db, config, [ref, ref2, ref], ["summary"], kickoff);
    // A PR named twice is checked once.
    expect(queue.items.map((i) => i.name)).toEqual(["r#1", "r#2"]);
    await until(async () => queue.currentRunIds.length > 0, "the queue joining PR 1's run");
    expect(queue.items[1]?.state).toBe("waiting");
    expect(await db.select().from(reviewWorkspacePrs)).toHaveLength(1);
    expect(startVerificationQueue(db, config, [ref2], ["summary"], kickoff)).toEqual({
      queue,
      existing: true,
    });

    release();
    await until(async () => (await queueBell()) !== undefined, "the queue's bell");
    // PR 2 has no branch on the test remote, so its checkout fails.
    expect(queue.items.map((i) => [i.name, i.state])).toEqual([
      ["r#1", "done"],
      ["r#2", "failed"],
    ]);
    expect(await queueBell()).toMatchObject({
      kind: "error",
      title: "Verification queue finished: 1 of 2 checked",
    });
  });

  it("cancels the PR running now and drops the rest", async () => {
    await heldRun();
    const { queue } = startVerificationQueue(db, config, [ref, ref2], ["summary"], kickoff);
    await until(async () => queue.currentRunIds.length > 0, "the queue joining PR 1's run");
    expect(cancelVerificationQueue(queue.id, kickoff)).toBe(true);
    expect(cancelVerificationQueue(queue.id, kickoff)).toBe(false);
    await until(async () => (await queueBell()) !== undefined, "the queue's bell");
    expect(queue.items.map((i) => i.state)).toEqual(["cancelled", "cancelled"]);
    expect(await queueBell()).toMatchObject({
      kind: "info",
      title: "Verification queue cancelled: 0 of 2 checked",
    });
  });
});
