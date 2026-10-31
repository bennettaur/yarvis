import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { fakeClaude, resultLine, testConfig } from "../agentRuns/testSupport.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, mutationRuns, reviewWorkspacePrs } from "../db/schema.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import type { PrRef } from "../pr/types.ts";
import { reviewGit } from "./git.ts";
import type { MutationPlan } from "./mutants.ts";
import type { MutationTestingConfig } from "./mutationConfig.ts";
import type { MutationExecution, MutationSummary } from "./mutationReport.ts";
import {
  failInterruptedMutationRuns,
  type MutationProgressEvent,
  mutantCopiesInUse,
} from "./mutationTesting.ts";
import type { ReviewProgressEvent } from "./progress.ts";
import { createReviewWorkspaceRoutes } from "./routes.ts";
import type { ReviewDeps } from "./service.ts";
import { createTestRemote, type TestRemote } from "./testRepo.ts";
import type { SandboxedCommand, SandboxedRun } from "./testSandbox.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const bin = mkdtempSync(join(tmpdir(), "yarvis-mutation-bin-"));
const config = testConfig(url, "");

// The test remote's PR changes src/a.ts to "export const a = 2;\nexport const b = 3;\n".
const PLAN: MutationPlan = {
  testCommands: [{ id: "unit", argv: ["bun", "test", "test/a.test.ts"], testFiles: [] }],
  positiveControls: [
    {
      path: "src/a.ts",
      line: 2,
      oldText: "b = 3",
      newText: "b = 30",
      description: "blatant",
      testCommandId: "unit",
    },
  ],
  mutants: [
    {
      id: "m1",
      path: "src/a.ts",
      line: 1,
      oldText: "a = 2",
      newText: "a = 20",
      description: "changed a",
      rationale: "a is new",
      testCommandId: "unit",
      testFiles: ["test/a.test.ts"],
      likelyEquivalent: false,
    },
    {
      id: "m2",
      path: "src/a.ts",
      line: 2,
      oldText: "b = 3",
      newText: "b = 4",
      description: "changed b",
      rationale: "b is new",
      testCommandId: "unit",
      testFiles: ["test/a.test.ts"],
      likelyEquivalent: false,
    },
  ],
  notes: "",
};

const FINDINGS = {
  findings: [
    {
      mutantId: "m1",
      title: "a is never asserted",
      detail: "No test reads a.",
      severity: "medium",
      suggestion: "expect(a).toBe(2)",
    },
  ],
};

const logDir = join(bin, "log");
const planFile = join(bin, "plan.jsonl");
const explainFile = join(bin, "explain.jsonl");
const init = JSON.stringify({ type: "system", subtype: "init", model: "m" });
function writeAnswers(plan: unknown, explanation: unknown = FINDINGS) {
  writeFileSync(planFile, `${init}\n${JSON.stringify(resultLine({ structured_output: plan }))}\n`);
  writeFileSync(
    explainFile,
    `${init}\n${JSON.stringify(resultLine({ structured_output: explanation, total_cost_usd: 0.02 }))}\n`,
  );
}

/**
 * Stands in for `claude`: tells the planning run from the explanation run by
 * the schema it was handed, records what each was asked and with which flags,
 * and holds the planning run while `GATED` exists.
 */
const program = fakeClaude(
  bin,
  "claude",
  [
    `mkdir -p "${logDir}"`,
    `case "$*" in`,
    `  *testCommands*) role=plan ;;`,
    `  *) role=explain ;;`,
    `esac`,
    `pwd > "${logDir}/$role.cwd"`,
    `cat > "${logDir}/$role.prompt"`,
    `printf '%s\\n' "$@" > "${logDir}/$role.args"`,
    `if [ "$role" = plan ] && [ -f "${bin}/GATED" ]; then while [ ! -f "${bin}/RELEASE" ]; do sleep 0.05; done; fi`,
    `cat "${bin}/$role.jsonl"`,
  ].join("\n"),
);

/** Mutants whose source holds this text block until the pass is cancelled. */
let blockOn: string | null;
let runnerCalls: SandboxedCommand[];
/** When set, a mutant's test run swaps src/a.ts for a link to this file. */
let swapOnMutant: string | null;

/**
 * Stands in for the sandboxed test runner: the control is caught, `a = 20`
 * survives, `b = 4` is caught.
 */
async function fakeRunner(command: SandboxedCommand): Promise<SandboxedRun> {
  runnerCalls.push(command);
  const source = readFileSync(join(command.cwd, "src", "a.ts"), "utf8");
  if (swapOnMutant && source.includes("a = 20")) {
    rmSync(join(command.cwd, "src", "a.ts"));
    symlinkSync(swapOnMutant, join(command.cwd, "src", "a.ts"));
  }
  if (blockOn && source.includes(blockOn)) {
    await new Promise<void>((resolve) => command.signal.addEventListener("abort", () => resolve()));
    return { exitCode: 143, output: "", timedOut: false, aborted: true, durationMs: 1 };
  }
  const caught = source.includes("b = 30") || source.includes("b = 4");
  return {
    exitCode: caught ? 1 : 0,
    output: caught
      ? " 1 pass\n 1 fail\nRan 2 tests across 1 file."
      : " 2 pass\n 0 fail\nRan 2 tests across 1 file.",
    timedOut: false,
    aborted: false,
    durationMs: 50,
  };
}

let remote: TestRemote;
let setupScript: string | null;
let agentRegistry: RunRegistry<AgentRunEvent>;
let registry: RunRegistry<MutationProgressEvent>;
let settings: MutationTestingConfig;
// Set to make startClaudeRun throw before it records a run.
let startFails: boolean;
/** When set, loading the PR waits on it, holding a refresh open. */
let loadGate: PromiseWithResolvers<void> | null;
let app: Hono;

const deps = (): ReviewDeps => ({
  loadPr: async () => {
    await loadGate?.promise;
    return {
      title: "Feature work",
      author: "octocat",
      headRef: "feature",
      baseRef: "main",
      fromFork: true,
    };
  },
  remoteUrlFor: async () => remote.url,
  credentialsFor: () => undefined,
  setupScriptFor: async () => setupScript,
  git: () => reviewGit({ allowFileProtocol: true }),
});

const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };
const json = { "Content-Type": "application/json" };

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: body === undefined ? undefined : json,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function prRow(prId: string) {
  const [row] = await db.select().from(reviewWorkspacePrs).where(eq(reviewWorkspacePrs.id, prId));
  if (!row) throw new Error("no row");
  return row;
}

async function waitForProgress(wsId: string, prId: string): Promise<ReviewProgressEvent[]> {
  const text = await (await call("GET", `/rw/${wsId}/prs/${prId}/progress`)).text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as ReviewProgressEvent);
}

/** A workspace holding the PR, cloned and checked out. */
async function readyPr(): Promise<{ wsId: string; prId: string; base: string; headSha: string }> {
  const res = await call("POST", "/rw", { name: "Review", refs: [ref] });
  const ws = (await res.json()) as { id: string; prs: { id: string }[] };
  const prId = ws.prs[0]?.id as string;
  await waitForProgress(ws.id, prId);
  const row = await prRow(prId);
  expect(row.worktreeStatus).toBe("ready");
  return { wsId: ws.id, prId, base: `/rw/${ws.id}/prs/${prId}`, headSha: row.headSha as string };
}

/** Grants setup consent for the current head and waits for the script, if any. */
async function consent(wsId: string, prId: string): Promise<void> {
  const { headSha } = await prRow(prId);
  const res = await call("POST", `/rw/${wsId}/prs/${prId}/setup`, {
    grant: true,
    script: setupScript,
    headSha,
  });
  expect(res.status).toBe(200);
  if (setupScript) await waitForProgress(wsId, prId);
}

async function passRow(id: string) {
  const [row] = await db.select().from(mutationRuns).where(eq(mutationRuns.id, id));
  if (!row) throw new Error("no mutation run");
  return row;
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Mutant copies currently in the workspace's folder. */
function copiesIn(wsId: string): string[] {
  return readdirSync(join(config.workspacesRoot, ".review", wsId)).filter((name) =>
    name.includes("-mutants-"),
  );
}

async function finished(runId: string) {
  await until(async () => (await passRow(runId)).status !== "running", "the pass to finish");
  await until(() => !mutantCopiesInUse.has(runId), "the copy to be released");
  return passRow(runId);
}

async function start(base: string, headSha: string, extra = {}) {
  const res = await call("POST", `${base}/mutation-testing`, { headSha, ...extra });
  return { res, body: (await res.json()) as { runId: string; existing: boolean; error?: string } };
}

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, agent_runs, mutation_runs RESTART IDENTITY CASCADE`;
  config.workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-mutation-root-"));
  remote = createTestRemote();
  setupScript = "true";
  settings = {
    planningModel: "haiku",
    planningBudgetUsd: 0.5,
    explanationModel: "sonnet",
    explanationBudgetUsd: 0.25,
    maxMutants: 5,
    testTimeoutCapSeconds: 60,
  };
  startFails = false;
  loadGate = null;
  blockOn = null;
  swapOnMutant = null;
  runnerCalls = [];
  writeAnswers(PLAN);
  rmSync(logDir, { recursive: true, force: true });
  rmSync(join(bin, "GATED"), { force: true });
  rmSync(join(bin, "RELEASE"), { force: true });
  agentRegistry = new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 });
  registry = new RunRegistry<MutationProgressEvent>({ historyCap: 500, followerQueueCap: 2_000 });
  app = new Hono().route(
    "/rw",
    createReviewWorkspaceRoutes(config, {
      deps,
      mutation: {
        run: {
          get program(): string {
            if (startFails) throw new Error("no Claude Code here");
            return program;
          },
          instance: "test",
          registry: agentRegistry,
        },
        exec: { runner: fakeRunner, checkSandbox: async () => {}, killStrays: async () => [] },
        registry,
        config: async () => settings,
      },
    }),
  );
});

afterEach(() => {
  // Let a gated fake or refresh a failed test left waiting finish.
  loadGate?.resolve();
  writeFileSync(join(bin, "RELEASE"), "");
  rmSync(config.workspacesRoot, { recursive: true, force: true });
  rmSync(remote.root, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
  rmSync(bin, { recursive: true, force: true });
});

describe("when a pass may start", () => {
  it("refuses until setup consent is granted for the current head and setup succeeded", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    const before = await start(base, headSha);
    expect(before.res.status).toBe(409);
    expect(before.body.error).toContain("consent");

    setupScript = "exit 1";
    await consent(wsId, prId);
    const failed = await start(base, headSha);
    expect(failed.res.status).toBe(409);
    expect(failed.body.error).toContain("setup failed");

    // A push picked up by a refresh moves the head; the old consent doesn't carry over.
    setupScript = "true";
    await consent(wsId, prId);
    remote.pushToPr("src/a.ts", "export const a = 5;\n");
    await call("POST", `${base}/refresh`);
    await waitForProgress(wsId, prId);
    const moved = await prRow(prId);
    expect(moved.headSha).not.toBe(headSha);
    const stale = await start(base, moved.headSha as string);
    expect(stale.res.status).toBe(409);
    expect(stale.body.error).toContain("earlier commit");
    expect(await db.select().from(mutationRuns)).toEqual([]);
    expect(copiesIn(wsId)).toEqual([]);
  });

  it("needs the tests confirmed when there is no setup script", async () => {
    setupScript = null;
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    const state = (await (await call("GET", `${base}/mutation-testing`)).json()) as {
      blocked: { needsTestConfirmation?: boolean } | null;
    };
    expect(state.blocked?.needsTestConfirmation).toBe(true);
    expect((await start(base, headSha)).res.status).toBe(409);
    const confirmed = await start(base, headSha, { confirmRunTests: true });
    expect(confirmed.res.status).toBe(202);
    await finished(confirmed.body.runId);
  });

  it("refuses a head the PR has moved on from, and a malformed one", async () => {
    const { wsId, prId, base } = await readyPr();
    await consent(wsId, prId);
    expect((await start(base, "b".repeat(40))).res.status).toBe(409);
    expect((await start(base, "HEAD")).res.status).toBe(400);
  });

  it("refuses while a refresh is moving the checkout", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    loadGate = Promise.withResolvers<void>();
    expect((await call("POST", `${base}/refresh`)).status).toBe(202);
    const refused = await start(base, headSha);
    expect(refused.res.status).toBe(409);
    expect(refused.body.error).toContain("being updated");
    loadGate.resolve();
    await waitForProgress(wsId, prId);
    expect(copiesIn(wsId)).toEqual([]);
  });

  it("refuses in an archived workspace", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    expect((await call("POST", `/rw/${wsId}/archive`)).status).toBe(202);
    expect((await start(base, headSha)).res.status).toBe(409);
    expect(await db.select().from(mutationRuns)).toEqual([]);
  });

  it("answers 404 for a PR that isn't in the workspace", async () => {
    const { wsId } = await readyPr();
    const res = await call(
      "GET",
      `/rw/${wsId}/prs/00000000-0000-4000-8000-000000000000/mutation-testing`,
    );
    expect(res.status).toBe(404);
  });
});

describe("a pass", () => {
  it("plans, runs the mutants itself, explains the survivors and removes the copy", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    const worktree = (await prRow(prId)).worktreePath;
    const original = readFileSync(join(worktree, "src", "a.ts"), "utf8");

    const { res, body } = await start(base, headSha);
    expect(res.status).toBe(202);
    const row = await finished(body.runId);

    expect(row).toMatchObject({ status: "succeeded", phase: "done", headSha, error: null });
    expect(row.plan).toEqual(PLAN);
    const execution = row.execution as MutationExecution;
    expect(execution.baselines[0]).toMatchObject({ passed: true, testCount: 2 });
    expect(execution.positiveControls.map((c) => [c.id, c.outcome])).toEqual([
      ["control-unit", "killed"],
    ]);
    expect(execution.mutants.map((m) => [m.id, m.outcome])).toEqual([
      ["m1", "survived"],
      ["m2", "killed"],
    ]);
    // Two valid mutants are too few for a verdict, whatever the rate.
    expect(row.summary as MutationSummary).toMatchObject({
      killed: 1,
      survived: 1,
      valid: 2,
      killRate: 0.5,
      verdict: "inconclusive",
    });
    expect(row.findings).toEqual([{ ...FINDINGS.findings[0], path: "src/a.ts", line: 1 }]);
    expect(row.costUsd).toBeCloseTo(0.03);

    // Both Claude Code runs are agent runs of their own, read-only, in the copy.
    const runs = await db.select().from(agentRuns);
    expect(runs.map((r) => r.kind).sort()).toEqual(["mutation-explain", "mutation-plan"]);
    expect([row.planRunId, row.explainRunId].sort()).toEqual(runs.map((r) => r.id).sort());
    const cwd = readFileSync(join(logDir, "plan.cwd"), "utf8").trim();
    expect(realpathSync(dirname(cwd))).toBe(realpathSync(dirname(worktree)));
    expect(cwd).toEndWith(`-mutants-${body.runId}`);
    for (const role of ["plan", "explain"]) {
      const args = readFileSync(join(logDir, `${role}.args`), "utf8").split("\n");
      const allowed = args.slice(
        args.indexOf("--allowedTools") + 1,
        args.indexOf("--disallowedTools"),
      );
      expect(allowed).toEqual(["Read(./**)", "Grep(./**)", "Glob(./**)"]);
      expect(args).toContain("Bash");
      expect(args).toContain("Edit");
    }
    const planArgs = readFileSync(join(logDir, "plan.args"), "utf8").split("\n");
    expect(planArgs[planArgs.indexOf("--model") + 1]).toBe("haiku");
    // The budget only warns, so nothing caps the run's spend.
    expect(planArgs).not.toContain("--max-budget-usd");

    // The planner sees the changed files fenced, and the cap.
    const prompt = readFileSync(join(logDir, "plan.prompt"), "utf8");
    expect(prompt).toContain("at most 5 mutants");
    const fenced = /<changed-files-([0-9a-f]{12})>\n([\s\S]*)\n<\/changed-files-\1>/.exec(
      prompt,
    )?.[2];
    expect(fenced?.split("\n")).toContain("src/a.ts (modified, +2 -1, changed lines 1-2)");
    // The explainer sees only the survivor.
    const explainPrompt = readFileSync(join(logDir, "explain.prompt"), "utf8");
    expect(explainPrompt).toContain("Mutant m1");
    expect(explainPrompt).not.toContain("Mutant m2");

    // The tests ran in the copy, and neither it nor the checkout kept a mutant.
    expect(runnerCalls.every((c) => c.cwd.endsWith(`-mutants-${body.runId}`))).toBe(true);
    expect(readFileSync(join(worktree, "src", "a.ts"), "utf8")).toBe(original);
    expect(copiesIn(wsId)).toEqual([]);

    const state = (await (await call("GET", `${base}/mutation-testing`)).json()) as {
      run: { id: string; isCurrentHead: boolean; live: boolean };
      blocked: unknown;
      sandboxNotes: string;
    };
    expect(state.run).toMatchObject({ id: body.runId, isCurrentHead: true, live: false });
    expect(state.blocked).toBeNull();
    expect(state.sandboxNotes).toContain("second line of defence");
  });

  it("skips the explanation when nothing survives", async () => {
    writeAnswers({ ...PLAN, mutants: [PLAN.mutants[1]] });
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    const row = await finished((await start(base, headSha)).body.runId);
    expect(row).toMatchObject({ status: "succeeded", explainRunId: null, findings: [] });
    expect(existsSync(join(logDir, "explain.args"))).toBe(false);
  });

  it("answers with the pass already going, and streams its progress", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    writeFileSync(join(bin, "GATED"), "");

    const first = await start(base, headSha);
    expect(first.res.status).toBe(202);
    const again = await start(base, headSha);
    expect(again.res.status).toBe(200);
    expect(again.body).toEqual({ runId: first.body.runId, existing: true });
    await until(() => existsSync(join(logDir, "plan.args")), "planning to start");

    const stream = call("GET", `${base}/mutation-testing/progress`);
    writeFileSync(join(bin, "RELEASE"), "");
    const events = (await (await stream).text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)) as MutationProgressEvent);
    const types = events.map((e) => (e.type === "phase" ? `phase:${e.phase}` : e.type));
    expect(types).toContain("phase:planning");
    expect(types).toContain("baseline");
    expect(types.filter((t) => t === "mutant")).toHaveLength(3);
    expect(types.at(-1)).toBe("done");
    await finished(first.body.runId);
  });

  it("keeps the results so far when cancelled, and removes the copy", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    blockOn = "b = 4";
    const { body } = await start(base, headSha);
    await until(async () => {
      const ex = (await passRow(body.runId)).execution as MutationExecution | null;
      return (ex?.mutants.length ?? 0) === 1;
    }, "the first mutant's result");
    await until(() => runnerCalls.length === 4, "the second mutant to start");

    const cancel = await call("POST", `${base}/mutation-testing/cancel`);
    expect(cancel.status).toBe(202);
    const row = await finished(body.runId);
    expect(row.status).toBe("cancelled");
    const execution = row.execution as MutationExecution;
    expect(execution.mutants.map((m) => m.id)).toEqual(["m1"]);
    expect((row.summary as MutationSummary).notes.join(" ")).toContain("partial results");
    expect(copiesIn(wsId)).toEqual([]);
    expect((await call("POST", `${base}/mutation-testing/cancel`)).status).toBe(409);
  });

  it("fails on a plan that doesn't match the schema, and removes the copy", async () => {
    writeAnswers({ mutants: "lots" });
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    const row = await finished((await start(base, headSha)).body.runId);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("planning failed");
    expect(row.execution).toBeNull();
    expect(runnerCalls).toEqual([]);
    expect(copiesIn(wsId)).toEqual([]);
  });

  it("fails, leaving no copy, when the planning run can't start", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    startFails = true;
    const row = await finished((await start(base, headSha)).body.runId);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("no Claude Code here");
    expect(copiesIn(wsId)).toEqual([]);
    expect(mutantCopiesInUse.size).toBe(0);
    expect(await db.select().from(agentRuns)).toEqual([]);
    // The PR is free for the next sync.
    expect((await call("POST", `${base}/refresh`)).status).toBe(202);
    await waitForProgress(wsId, prId);
  });

  it("fails the pass, and still removes the copy, when the tests swap a file for a link", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    const target = join(bin, "outside-target.ts");
    writeFileSync(target, "outside\n");
    swapOnMutant = target;
    const row = await finished((await start(base, headSha)).body.runId);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/could not restore .*src\/a\.ts after a mutant/);
    expect(readFileSync(target, "utf8")).toBe("outside\n");
    expect(copiesIn(wsId)).toEqual([]);
  });

  it("marks this instance's interrupted passes failed at startup, and no one else's", async () => {
    const { wsId, prId, headSha } = await readyPr();
    const values = {
      workspaceId: wsId,
      prId,
      refKey: "gh:o/r/1",
      headSha,
      status: "running" as const,
    };
    const before = new Date(Date.now() - 60_000);
    await db.insert(mutationRuns).values([
      { ...values, instance: "test", startedAt: before },
      { ...values, instance: "other", startedAt: before },
      { ...values, instance: "test", startedAt: new Date(Date.now() + 60_000) },
    ]);
    expect(await failInterruptedMutationRuns(db, "test", new Date())).toBe(1);
    const rows = await db.select().from(mutationRuns);
    expect(rows.map((r) => [r.instance, r.status]).sort()).toEqual([
      ["other", "running"],
      ["test", "failed"],
      ["test", "running"],
    ]);
    expect(rows.find((r) => r.status === "failed")?.error).toContain("interrupted");
  });

  it("reports the latest pass as stale after a push", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    await finished((await start(base, headSha)).body.runId);
    remote.pushToPr("src/a.ts", "export const a = 9;\n");
    await call("POST", `${base}/refresh`);
    await waitForProgress(wsId, prId);
    const state = (await (await call("GET", `${base}/mutation-testing`)).json()) as {
      run: { headSha: string; isCurrentHead: boolean };
      blocked: { reason: string };
    };
    expect(state.run).toMatchObject({ headSha, isCurrentHead: false });
    expect(state.blocked.reason).toContain("earlier commit");
  });
});
