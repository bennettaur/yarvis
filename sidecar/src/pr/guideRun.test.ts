import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { listAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { kickOffGuide } from "./guideRun.ts";
import { getGuide, saveGuide } from "./guides.ts";
import type { PrCodeSource } from "./source.ts";
import type { PrDetail, PrRef } from "./types.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

// The keys only get past the provider and model checks; the source and the
// guide agent are replaced, so nothing reaches the network.
const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-root",
  secrets: { githubToken: "test-github-token", anthropicApiKey: "test-key" },
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};

const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };
const head = "c".repeat(40);
const steps = [
  { path: "src/api.ts", startLine: 1, endLine: 10, explanation: "the request arrives here" },
  { path: "src/db.ts", startLine: 5, endLine: 9, explanation: "and is finally written here" },
];
const source = {
  ref,
  detail: async () => ({ title: "Feature work", headSha: head }) as PrDetail,
} as unknown as PrCodeSource;
const graph = { nodes: [], edges: [] };

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(async () => {
  await sql`TRUNCATE pr_guides RESTART IDENTITY`;
  await sql`TRUNCATE attention_items RESTART IDENTITY`;
  await sql`TRUNCATE events RESTART IDENTITY`;
});

afterAll(async () => {
  await sql.end();
});

describe("kickOffGuide", () => {
  it("answers at once, then saves the guide with the PR's title and link", async () => {
    const { promise: agentGate, resolve: openAgent } = Promise.withResolvers<void>();
    const runTour = async () => {
      await agentGate;
      return { steps, headSha: head, graph };
    };
    expect(await kickOffGuide(db, config, ref, { source, runTour })).toEqual({
      status: "started",
    });
    // A second ask while the first is still writing joins it.
    expect(await kickOffGuide(db, config, ref, { source, runTour })).toEqual({
      status: "already-running",
    });

    openAgent();
    await until(async () => (await listAttention(db, {})).length > 0, "the guide's bell item");
    const guide = await getGuide(db, ref);
    expect(guide).toMatchObject({
      title: "Feature work",
      url: "https://github.com/o/r/pull/1",
      headSha: head,
    });
    const [item] = await listAttention(db, {});
    expect(item).toMatchObject({ title: "Reviewing Feature work", kind: "info" });
  });

  it("keeps an existing guide unless asked to regenerate it", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps, graph, title: "Old", url: null });
    let ran = 0;
    const runTour = async () => {
      ran++;
      return { steps: steps.slice(0, 1), headSha: head, graph };
    };

    expect(await kickOffGuide(db, config, ref, { source, runTour })).toEqual({
      status: "exists",
      stale: true,
      progress: "step 1 of 2",
    });
    expect(ran).toBe(0);

    expect(await kickOffGuide(db, config, ref, { source, runTour, regenerate: true })).toEqual({
      status: "started",
    });
    // A one-step guide counts as finished, so it rings no bell: wait on the
    // row, then on the run letting go, which is when a plain ask sees it again.
    await until(async () => (await getGuide(db, ref))?.headSha === head, "the new guide");
    await until(
      async () => (await kickOffGuide(db, config, ref, { source, runTour })).status === "exists",
      "the run to finish",
    );
    expect((await getGuide(db, ref))?.steps).toHaveLength(1);
    expect(ran).toBe(1);
  });

  it("rings the bell when the agent fails, without the error's text", async () => {
    const runTour = async () => {
      throw new Error("provider said: token sk-secret is invalid");
    };
    expect(await kickOffGuide(db, config, ref, { source, runTour })).toEqual({
      status: "started",
    });
    await until(async () => (await listAttention(db, {})).length > 0, "the failure notice");
    const [item] = await listAttention(db, {});
    expect(item).toMatchObject({ title: "Guided review failed", kind: "error" });
    expect(item?.body).not.toContain("sk-secret");
    expect(await getGuide(db, ref)).toBeNull();

    // A later success clears the failure rather than sitting beside it.
    const ok = async () => ({ steps, headSha: head, graph });
    await until(
      async () =>
        (await kickOffGuide(db, config, ref, { source, runTour: ok })).status === "started",
      "the failed run to let go",
    );
    await until(async () => (await getGuide(db, ref)) !== null, "the guide");
    await until(
      async () => (await listAttention(db, {})).some((a) => a.kind === "info"),
      "the guide's bell item",
    );
    const pending = (await listAttention(db, {})).filter((a) => a.status === "pending");
    expect(pending.map((a) => a.title)).toEqual(["Reviewing Feature work"]);
  });

  it("refuses without provider credentials before reading anything", async () => {
    expect(await kickOffGuide(db, { ...config, secrets: {} }, ref)).toEqual({
      status: "error",
      error: "github token not configured",
    });
  });
});
