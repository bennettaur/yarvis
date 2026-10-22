import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { createAgentRunRoutes } from "../agentRuns/routes.ts";
import { fakeClaude, resultLine, testConfig } from "../agentRuns/testSupport.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, reviewWorkspacePrs } from "../db/schema.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import type { PrRef } from "../pr/types.ts";
import { reviewGit } from "./git.ts";
import { MUTATION_RUN_KIND } from "./mutantCopy.ts";
import type { MutationTestingConfig } from "./mutationConfig.ts";
import { type MutationReport, mutantCopiesInUse } from "./mutationTesting.ts";
import type { ReviewProgressEvent } from "./progress.ts";
import { createReviewWorkspaceRoutes } from "./routes.ts";
import type { ReviewDeps } from "./service.ts";
import { createTestRemote, type TestRemote } from "./testRepo.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const bin = mkdtempSync(join(tmpdir(), "yarvis-mutation-bin-"));
const config = testConfig(url, "");

const REPORT: MutationReport = {
  baseline: { command: "bun test", passed: true },
  mutants: [
    {
      path: "src/a.ts",
      line: 1,
      original: "a = 2",
      mutated: "a = 3",
      description: "Changed a constant",
      tests: ["test/a.test.ts"],
      outcome: "survived",
      evidence: "1 pass, 0 fail",
    },
  ],
  summary: { killed: 0, survived: 1, errors: 0, verdict: "weak" },
  findings: [
    {
      title: "a is never asserted",
      detail: "No test reads a.",
      path: "src/a.ts",
      line: 1,
      severity: "medium",
      suggestion: "expect(a).toBe(2)",
    },
  ],
};

/**
 * Stands in for `claude`: records where it ran, what it was asked and with
 * which flags, makes a "mutant" in its working directory, waits for the test
 * to release it when `GATED` exists, then reports.
 */
const logDir = join(bin, "log");
const result = join(bin, "result.jsonl");
writeFileSync(
  result,
  `${JSON.stringify({ type: "system", subtype: "init", model: "m" })}\n${JSON.stringify(
    resultLine({ structured_output: REPORT }),
  )}\n`,
);
const program = fakeClaude(
  bin,
  "claude",
  [
    `mkdir -p "${logDir}"`,
    `pwd > "${logDir}/cwd"`,
    `cat > "${logDir}/prompt"`,
    `printf '%s\\n' "$@" > "${logDir}/args"`,
    `echo mutated >> src/a.ts`,
    `if [ -f "${bin}/GATED" ]; then while [ ! -f "${bin}/RELEASE" ]; do sleep 0.05; done; fi`,
    `cat "${result}"`,
  ].join("\n"),
);

let remote: TestRemote;
let setupScript: string | null;
let registry: RunRegistry<AgentRunEvent>;
let settings: MutationTestingConfig;
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

async function runRow(id: string) {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
  if (!row) throw new Error("no run");
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
  await until(async () => (await runRow(runId)).status !== "running", "the run to finish");
  return runRow(runId);
}

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, agent_runs RESTART IDENTITY CASCADE`;
  config.workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-mutation-root-"));
  remote = createTestRemote();
  setupScript = "true";
  settings = { model: "haiku", maxBudgetUsd: 0.5, maxMutants: 5 };
  loadGate = null;
  rmSync(logDir, { recursive: true, force: true });
  rmSync(join(bin, "GATED"), { force: true });
  rmSync(join(bin, "RELEASE"), { force: true });
  registry = new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 });
  app = new Hono()
    .route(
      "/rw",
      createReviewWorkspaceRoutes(config, {
        deps,
        mutation: {
          run: { program, instance: "test", registry },
          config: async () => settings,
        },
      }),
    )
    .route("/runs", createAgentRunRoutes(config, registry));
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

describe("starting mutation testing", () => {
  it("refuses until setup consent is granted for the current head and setup succeeded", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    const before = await call("POST", `${base}/mutation-testing`, { headSha });
    expect(before.status).toBe(409);
    expect(((await before.json()) as { error: string }).error).toContain("consent");

    setupScript = "exit 1";
    await consent(wsId, prId);
    const failed = await call("POST", `${base}/mutation-testing`, { headSha });
    expect(failed.status).toBe(409);
    expect(((await failed.json()) as { error: string }).error).toContain("setup failed");

    // A push picked up by a refresh moves the head; the old consent doesn't carry over.
    setupScript = "true";
    await consent(wsId, prId);
    remote.pushToPr("src/a.ts", "export const a = 5;\n");
    await call("POST", `${base}/refresh`);
    await waitForProgress(wsId, prId);
    const moved = await prRow(prId);
    expect(moved.headSha).not.toBe(headSha);
    const stale = await call("POST", `${base}/mutation-testing`, { headSha: moved.headSha });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toContain("earlier commit");
    expect(await db.select().from(agentRuns)).toEqual([]);
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
    expect((await call("POST", `${base}/mutation-testing`, { headSha })).status).toBe(409);
    const res = await call("POST", `${base}/mutation-testing`, { headSha, confirmRunTests: true });
    expect(res.status).toBe(202);
    await finished(((await res.json()) as { runId: string }).runId);
  });

  it("refuses a head the PR has moved on from, and a malformed one", async () => {
    const { wsId, prId, base } = await readyPr();
    await consent(wsId, prId);
    expect(
      (await call("POST", `${base}/mutation-testing`, { headSha: "b".repeat(40) })).status,
    ).toBe(409);
    expect((await call("POST", `${base}/mutation-testing`, { headSha: "HEAD" })).status).toBe(400);
  });

  it("runs in a scratch copy, stores the report and removes the copy", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    const worktree = (await prRow(prId)).worktreePath;
    const original = readFileSync(join(worktree, "src", "a.ts"), "utf8");

    const res = await call("POST", `${base}/mutation-testing`, { headSha });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const row = await finished(runId);

    expect(row).toMatchObject({
      kind: MUTATION_RUN_KIND,
      targetKey: `gh:o/r/1@${headSha}`,
      status: "succeeded",
      result: REPORT,
    });
    expect(row.meta).toMatchObject({ prId, headSha, maxMutants: 5 });

    // It ran in a copy next to the checkout, which its mutant never reached.
    const cwd = readFileSync(join(logDir, "cwd"), "utf8").trim();
    expect(realpathSync(dirname(cwd))).toBe(realpathSync(dirname(worktree)));
    expect(cwd).toContain(`-mutants-${row.meta.copyId}`);
    expect(readFileSync(join(worktree, "src", "a.ts"), "utf8")).toBe(original);
    await until(() => copiesIn(wsId).length === 0, "the copy to be removed");

    // The prompt fences the changed files and carries the configured cap.
    const prompt = readFileSync(join(logDir, "prompt"), "utf8");
    expect(prompt).toContain("at most 5 mutants");
    const fenced = /<changed-files-([0-9a-f]{12})>\n([\s\S]*)\n<\/changed-files-\1>/.exec(
      prompt,
    )?.[2];
    expect(fenced?.split("\n")).toContain("src/a.ts (modified, +2 -1, changed lines 1-2)");
    expect(prompt).not.toContain("docs/gone.md");
    const args = readFileSync(join(logDir, "args"), "utf8").split("\n");
    expect(args).toContain("--plugin-dir");
    expect(args).toContain("Bash(git checkout -- *)");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.5");

    const state = (await (await call("GET", `${base}/mutation-testing`)).json()) as {
      run: { id: string; isCurrentHead: boolean; result: unknown };
      blocked: unknown;
    };
    expect(state.run).toMatchObject({ id: runId, isCurrentHead: true, result: REPORT });
    expect(state.blocked).toBeNull();
  });

  it("answers with the run already going, and removes its copy when it is cancelled", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    writeFileSync(join(bin, "GATED"), "");

    const first = await call("POST", `${base}/mutation-testing`, { headSha });
    expect(first.status).toBe(202);
    const { runId } = (await first.json()) as { runId: string };
    const again = await call("POST", `${base}/mutation-testing`, { headSha });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ runId, existing: true });
    await until(() => existsSync(join(logDir, "cwd")), "the run to start");
    expect(copiesIn(wsId)).toHaveLength(1);

    expect((await call("POST", `/runs/${runId}/cancel`)).status).toBe(202);
    expect((await finished(runId)).status).toBe("cancelled");
    await until(() => copiesIn(wsId).length === 0, "the copy to be removed");
  });

  it("starts one run for two clicks at once", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    writeFileSync(join(bin, "GATED"), "");
    const answers = await Promise.all([
      call("POST", `${base}/mutation-testing`, { headSha }),
      call("POST", `${base}/mutation-testing`, { headSha }),
    ]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 202]);
    const ids = await Promise.all(
      answers.map(async (res) => ((await res.json()) as { runId: string }).runId),
    );
    expect(ids[0]).toBe(ids[1] as string);
    writeFileSync(join(bin, "RELEASE"), "");
    await finished(ids[0] as string);
    await until(() => copiesIn(wsId).length === 0, "the copy to be removed");
  });

  it("removes the copy when the run fails, and reports the latest run as stale after a push", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    writeFileSync(result, `${JSON.stringify(resultLine({ structured_output: { nope: 1 } }))}\n`);
    try {
      const { runId } = (await (
        await call("POST", `${base}/mutation-testing`, { headSha })
      ).json()) as { runId: string };
      const row = await finished(runId);
      expect(row.status).toBe("failed");
      expect(row.error).toContain("did not match the expected shape");
      await until(() => copiesIn(wsId).length === 0, "the copy to be removed");
    } finally {
      writeFileSync(
        result,
        `${JSON.stringify({ type: "system", subtype: "init", model: "m" })}\n${JSON.stringify(
          resultLine({ structured_output: REPORT }),
        )}\n`,
      );
    }

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

  it("refuses while a refresh is moving the checkout", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    loadGate = Promise.withResolvers<void>();
    expect((await call("POST", `${base}/refresh`)).status).toBe(202);
    const res = await call("POST", `${base}/mutation-testing`, { headSha });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("being updated");
    loadGate.resolve();
    await waitForProgress(wsId, prId);
    expect(copiesIn(wsId)).toEqual([]);
  });

  it("refuses in an archived workspace", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    expect((await call("POST", `/rw/${wsId}/archive`)).status).toBe(202);
    const res = await call("POST", `${base}/mutation-testing`, { headSha });
    expect(res.status).toBe(409);
    expect(await db.select().from(agentRuns)).toEqual([]);
  });

  it("removes the copy and records nothing when the run can't start", async () => {
    const { wsId, prId, base, headSha } = await readyPr();
    await consent(wsId, prId);
    // startClaudeRun refuses a run with no budget, after the copy is made.
    settings = { ...settings, maxBudgetUsd: 0 };
    const res = await call("POST", `${base}/mutation-testing`, { headSha });
    expect(res.status).toBe(500);
    expect(copiesIn(wsId)).toEqual([]);
    expect(mutantCopiesInUse.size).toBe(0);
    expect(await db.select().from(agentRuns)).toEqual([]);
    // The PR is free for the next sync.
    expect((await call("POST", `${base}/refresh`)).status).toBe(202);
    await waitForProgress(wsId, prId);
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
