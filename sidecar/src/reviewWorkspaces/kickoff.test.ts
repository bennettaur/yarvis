import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { fakeClaude, resultLine } from "../agentRuns/testSupport.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, attentionItems, reviewWorkspacePrs } from "../db/schema.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import type { PrDetail, PrRef } from "../pr/types.ts";
import { reviewGit } from "./git.ts";
import { type KickoffDeps, kickOffVerification } from "./kickoff.ts";
import type { PrMeta, ReviewDeps } from "./service.ts";
import { createTestRemote, type TestRemote } from "./testRepo.ts";

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
  risk: { level: "low", clientImpact: "None.", mitigations: [], concerns: [] },
  completeness: pass,
  tests: pass,
  complexity: pass,
  performance: pass,
  comments: pass,
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

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, agent_runs, attention_items RESTART IDENTITY CASCADE`;
  config.workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-kickoff-root-"));
  remote = createTestRemote();
  checkoutFails = false;
  fakeDir = mkdtempSync(join(tmpdir(), "yarvis-kickoff-fake-"));
  writeFileSync(
    join(fakeDir, "result.jsonl"),
    `${JSON.stringify(resultLine({ structured_output: report }))}\n`,
  );
  // Holds the run open until the test releases it, then hands in the report.
  const program = fakeClaude(
    fakeDir,
    "claude",
    `cat > /dev/null
while [ ! -f "${fakeDir}/release" ]; do sleep 0.02; done
cat "${fakeDir}/result.jsonl"`,
  );
  const inner = reviewGit({ allowFileProtocol: true });
  const review: ReviewDeps = {
    loadPr: async () => meta,
    remoteUrlFor: async () => remote.url,
    credentialsFor: () => undefined,
    setupScriptFor: async () => null,
    git: () => ({
      ...inner,
      local: async (args, opts) =>
        args[0] === "checkout" && checkoutFails
          ? { stdout: "", stderr: "checkout exploded", exitCode: 1 }
          : inner.local(args, opts),
    }),
    stackOf: async () => [],
  };
  kickoff = {
    review,
    verification: {
      loadDetail: async () => ({ title: "Feature work", body: "" }) as unknown as PrDetail,
      settings: async () => ({ model: "haiku", maxBudgetUsd: 100 }),
      run: {
        program,
        registry: new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 }),
        instance: "test",
      },
    },
    pollMs: 25,
  };
});

afterEach(() => {
  release();
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
    await until(
      async () => (await attention()).some((a) => a.title.includes("go-ahead")),
      "the go-ahead notice",
    );
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
    const again = await kickOffVerification(db, config, ref, {}, kickoff);
    expect(again).toMatchObject({
      status: "needs-confirmation",
      workspaceId: first.workspaceId,
      prId: first.prId,
      size: { large: true },
    });
  });

  it("starts once confirmed, joins the running report, and rings the bell when it ends", async () => {
    await kickOffVerification(db, config, ref, {}, kickoff);
    await until(async () => (await attention()).length > 0, "the checkout");
    await sql`TRUNCATE attention_items`;

    const started = await kickOffVerification(db, config, ref, { confirmed: true }, kickoff);
    expect(started).toMatchObject({ status: "started" });
    if (started.status !== "started") throw new Error("unreachable");

    const joined = await kickOffVerification(db, config, ref, {}, kickoff);
    expect(joined).toEqual({ ...started, status: "already-running" });

    release();
    await until(
      async () => (await attention()).some((a) => a.title === "Verification report ready"),
      "the ready notice",
    );
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, started.runId));
    expect(run?.status).toBe("succeeded");
    // One run, and one notice for it, though it was asked for twice.
    const ready = (await attention()).filter((a) => a.title === "Verification report ready");
    expect(ready).toHaveLength(1);
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
    const [pr] = await db.select().from(reviewWorkspacePrs);
    expect(pr?.worktreeStatus).toBe("error");
  });
});
