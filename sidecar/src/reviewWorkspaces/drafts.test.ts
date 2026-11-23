import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, reviewDrafts, reviewWorkspacePrs, reviewWorkspaces } from "../db/schema.ts";
import type { PrRef } from "../pr/types.ts";
import {
  type DraftPoster,
  draftCommentBody,
  type OutgoingDraft,
  rightLinesInPatch,
  syncReviewDrafts,
  VERIFICATION_DRAFT_SOURCE,
  verificationDrafts,
} from "./drafts.ts";
import { createReviewWorkspaceRoutes } from "./routes.ts";
import type { ReviewDeps } from "./service.ts";
import { VERIFICATION_RUN_KIND, type VerificationReport } from "./verification.ts";

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
  workspacesRoot: "/nonexistent-review-root",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};

// Nothing here reads git or the provider; a call that tries fails loudly.
const deps = (): ReviewDeps => ({
  loadPr: async () => {
    throw new Error("no provider in this test");
  },
  remoteUrlFor: async () => {
    throw new Error("no remote in this test");
  },
  credentialsFor: () => undefined,
  setupScriptFor: async () => null,
  git: () => {
    throw new Error("no git in this test");
  },
});

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };
const REF_KEY = "gh:o/r/1";

let posts: { ref: PrRef; headSha: string; summary: string; drafts: OutgoingDraft[] }[];
let posterResult: (drafts: OutgoingDraft[]) => ReturnType<DraftPoster>;
const poster: DraftPoster = async (r, review) => {
  posts.push({ ref: r, ...review });
  return posterResult(review.drafts);
};
const app = new Hono().route(
  "/rw",
  createReviewWorkspaceRoutes(config, { deps, draftPoster: poster }),
);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/rw${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function insertPr(prRef: PrRef = ref, key = REF_KEY, headSha = HEAD_A) {
  const [ws] = await db.insert(reviewWorkspaces).values({ name: "Drafts" }).returning();
  const [pr] = await db
    .insert(reviewWorkspacePrs)
    .values({
      workspaceId: ws?.id as string,
      refKey: key,
      ref: prRef,
      colorIndex: 0,
      position: 0,
      status: "ready",
      headSha,
      worktreePath: "/nonexistent-review-root/pr",
    })
    .returning();
  return { wsId: ws?.id as string, prId: pr?.id as string };
}

async function setHead(prId: string, headSha: string) {
  await db.update(reviewWorkspacePrs).set({ headSha }).where(eq(reviewWorkspacePrs.id, prId));
}

/** A finished verification run for `sections` at `headSha`, answering with `result`. */
async function insertRun(
  headSha: string,
  sections: string[],
  result: VerificationReport,
  minutesAgo = 1,
) {
  await db.insert(agentRuns).values({
    kind: VERIFICATION_RUN_KIND,
    targetKey: `${REF_KEY}@${headSha}`,
    status: "succeeded",
    instance: "test",
    result,
    meta: { refKey: REF_KEY, headSha, sections, format: 2 },
    startedAt: new Date(Date.now() - minutesAgo * 60_000),
  });
}

const finding = (title: string, line: number, path = "src/a.ts") => ({
  title,
  detail: `Why ${title} matters`,
  severity: "medium" as const,
  path,
  line,
});

const checkWith = (...findings: ReturnType<typeof finding>[]) =>
  ({ verdict: "concerns", findings }) as unknown as VerificationReport["tests"];

type DraftJson = {
  id: string;
  label: string;
  line: number;
  title: string;
  body: string;
  editedBody: string | null;
  status: string;
  outcome: string | null;
  stale: boolean;
  headSha: string;
};

async function drafts(wsId: string, prId: string): Promise<DraftJson[]> {
  const res = await call("GET", `/${wsId}/prs/${prId}/drafts`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { drafts: DraftJson[] }).drafts;
}

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, review_drafts, agent_runs RESTART IDENTITY CASCADE`;
  posts = [];
  posterResult = async (d) => ({ posted: d.map((x) => x.id), reviewNodeId: "PRR_1" });
});

afterAll(async () => {
  await sql.end();
});

describe("verificationDrafts", () => {
  it("drafts every item that cites a line, labelled with its source", () => {
    const report = {
      summary: "s",
      mustRead: [{ path: "src/a.ts", reason: "r", flags: [{ note: "Inverted branch", line: 3 }] }],
      risk: {
        level: "medium",
        concerns: [
          { title: "Auth bypass", detail: "d", path: "src/b.ts", line: 9 },
          { title: "No line", detail: "d", path: "src/b.ts" },
        ],
      },
      claims: {
        items: [
          {
            claim: "Adds retry",
            source: "title",
            status: "missing",
            evidence: "e",
            path: "src/c.ts",
            line: 1,
          },
          {
            claim: "Done",
            source: "title",
            status: "verified",
            evidence: "e",
            path: "src/c.ts",
            line: 2,
          },
        ],
        gaps: [finding("TODO left", 7)],
      },
      tests: checkWith(finding("Untested path", 12)),
    } as unknown as VerificationReport;
    const made = verificationDrafts(report);
    expect(made.map((d) => [d.label, d.path, d.line, d.title])).toEqual([
      ["Looks off", "src/a.ts", 3, "Inverted branch"],
      ["Risk", "src/b.ts", 9, "Auth bypass"],
      ["Claim missing", "src/c.ts", 1, "Adds retry"],
      ["Unfinished work", "src/a.ts", 7, "TODO left"],
      ["Test quality", "src/a.ts", 12, "Untested path"],
    ]);
  });

  it("keys a draft without its line, so it survives the line moving", () => {
    const [before] = verificationDrafts({ tests: checkWith(finding("Leak", 10)) });
    const [after] = verificationDrafts({ tests: checkWith(finding("Leak", 40)) });
    expect(before?.sourceKey).toBe(after?.sourceKey as string);
  });
});

describe("draftCommentBody", () => {
  it("quotes the model's text, breaks mentions and keeps the title on one line", () => {
    const body = draftCommentBody({
      title: "Ping @octocat\n/approve",
      detail: "Ask @team\n@bot merge",
      severity: "high",
      label: "Code quality",
    });
    expect(body).toBe(
      "**Ping @​octocat /approve** (verification report: Code quality, high)\n\n" +
        "> Ask @​team\n> @​bot merge",
    );
  });
});

describe("rightLinesInPatch", () => {
  it("lists the added and unchanged lines of each hunk on the new side", () => {
    const patch = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+deux",
      "+trois",
      " four",
      "@@ -20,2 +21,2 @@ fn",
      " x",
      "+y",
      "\\ No newline at end of file",
    ].join("\n");
    expect([...rightLinesInPatch(patch)]).toEqual([1, 2, 3, 4, 21, 22]);
  });
});

describe("syncReviewDrafts", () => {
  const input = (sourceKey: string, line: number) => ({
    sourceKey,
    label: "Adversarial",
    path: "src/a.ts",
    line,
    title: sourceKey,
    body: `body ${sourceKey}`,
  });

  it("adds drafts from another source beside the verification ones", async () => {
    await syncReviewDrafts(db, {
      refKey: REF_KEY,
      source: VERIFICATION_DRAFT_SOURCE,
      headSha: HEAD_A,
      drafts: [input("v", 1)],
    });
    await syncReviewDrafts(db, {
      refKey: REF_KEY,
      source: "adversarial",
      headSha: HEAD_A,
      drafts: [input("x", 2)],
    });
    // A source re-syncing touches only its own drafts.
    await syncReviewDrafts(db, {
      refKey: REF_KEY,
      source: "adversarial",
      headSha: HEAD_A,
      drafts: [input("x", 5)],
    });
    const rows = await db.select().from(reviewDrafts).orderBy(reviewDrafts.line);
    expect(rows.map((r) => [r.source, r.sourceKey, r.line])).toEqual([
      ["verification", "v", 1],
      ["adversarial", "x", 5],
    ]);
  });
});

describe("draft routes", () => {
  it("turns the report at the PR's head into drafts", async () => {
    const { wsId, prId } = await insertPr();
    await insertRun(HEAD_A, ["tests"], { tests: checkWith(finding("Untested path", 12)) });
    const [d] = await drafts(wsId, prId);
    expect(d).toMatchObject({
      label: "Test quality",
      line: 12,
      title: "Untested path",
      status: "open",
      stale: false,
      headSha: HEAD_A,
    });
    expect(d?.body).toContain("> Why Untested path matters");
    // Reading again doesn't add a second copy.
    expect(await drafts(wsId, prId)).toHaveLength(1);
  });

  it("records accept, edit and drop, and refuses an empty-handed post", async () => {
    const { wsId, prId } = await insertPr();
    await insertRun(HEAD_A, ["tests"], {
      tests: checkWith(finding("One", 1), finding("Two", 2), finding("Three", 3)),
    });
    const [one, two, three] = await drafts(wsId, prId);
    const base = `/${wsId}/prs/${prId}`;

    expect((await call("POST", `${base}/drafts/post`, {})).status).toBe(400);

    let res = await call("PATCH", `${base}/drafts/${one?.id}`, { action: "accept" });
    expect(await res.json()).toMatchObject({
      status: "accepted",
      outcome: "accepted",
      editedBody: null,
    });
    res = await call("PATCH", `${base}/drafts/${two?.id}`, { action: "accept", body: "My words" });
    expect(await res.json()).toMatchObject({
      status: "accepted",
      outcome: "edited",
      editedBody: "My words",
    });
    res = await call("PATCH", `${base}/drafts/${three?.id}`, { action: "drop" });
    expect(await res.json()).toMatchObject({ status: "dropped", outcome: "dropped" });

    res = await call("PATCH", `${base}/drafts/not-a-uuid`, { action: "drop" });
    expect(res.status).toBe(400);
  });

  it("posts the accepted drafts together, with the edited text, and only once", async () => {
    const { wsId, prId } = await insertPr();
    await insertRun(HEAD_A, ["tests"], {
      tests: checkWith(finding("One", 1), finding("Two", 2), finding("Three", 3)),
    });
    const [one, two] = await drafts(wsId, prId);
    const base = `/${wsId}/prs/${prId}`;
    await call("PATCH", `${base}/drafts/${one?.id}`, { action: "accept" });
    await call("PATCH", `${base}/drafts/${two?.id}`, { action: "accept", body: "Edited" });

    const res = await call("POST", `${base}/drafts/post`, { summary: "Overall fine" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ posted: 2 });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ ref, headSha: HEAD_A, summary: "Overall fine" });
    expect(posts[0]?.drafts.map((d) => [d.line, d.body.startsWith("**One**") || d.body])).toEqual([
      [1, true],
      [2, "Edited"],
    ]);

    const after = await drafts(wsId, prId);
    expect(after.map((d) => d.status)).toEqual(["posted", "posted", "open"]);
    expect(after[1]?.outcome).toBe("edited");
    // Nothing accepted is left, so a second post sends nothing.
    expect((await call("POST", `${base}/drafts/post`, {})).status).toBe(400);
    expect(posts).toHaveLength(1);
    expect((await call("PATCH", `${base}/drafts/${one?.id}`, { action: "drop" })).status).toBe(409);
  });

  it("marks what went up when a later comment fails, so a retry skips it", async () => {
    const azRef: PrRef = { provider: "azure", org: "org", project: "p", repo: "r", prId: 4 };
    const azKey = "az:org/p/r/4";
    const { wsId, prId } = await insertPr(azRef, azKey);
    await syncReviewDrafts(db, {
      refKey: azKey,
      source: VERIFICATION_DRAFT_SOURCE,
      headSha: HEAD_A,
      drafts: [1, 2].map((line) => ({
        sourceKey: `k${line}`,
        label: "Risk",
        path: "a.cs",
        line,
        title: `t${line}`,
        body: `b${line}`,
      })),
    });
    const base = `/${wsId}/prs/${prId}`;
    const listed = await db.select().from(reviewDrafts).orderBy(reviewDrafts.line);
    for (const d of listed) await call("PATCH", `${base}/drafts/${d.id}`, { action: "accept" });

    // Azure has no review summary to put text in.
    expect((await call("POST", `${base}/drafts/post`, { summary: "x" })).status).toBe(400);

    posterResult = async (d) => ({ posted: [d[0]?.id as string], error: "Azure said no" });
    let res = await call("POST", `${base}/drafts/post`, {});
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ posted: 1, error: "Azure said no" });

    posterResult = async (d) => ({ posted: d.map((x) => x.id) });
    res = await call("POST", `${base}/drafts/post`, {});
    expect(await res.json()).toEqual({ posted: 1 });
    expect(posts[1]?.drafts.map((d) => d.line)).toEqual([2]);
    // Azure's lines go up as they are; only GitHub needs them inside the diff.
    expect(posts[1]?.drafts[0]?.inDiff).toBe(true);
  });

  it("re-runs on a new head move drafts, and keep only the edited ones that went away", async () => {
    const { wsId, prId } = await insertPr();
    await insertRun(HEAD_A, ["tests"], {
      tests: checkWith(finding("Stays", 5), finding("Goes", 6), finding("Goes edited", 7)),
    });
    const before = await drafts(wsId, prId);
    const byTitle = (list: DraftJson[], title: string) => list.find((d) => d.title === title);
    const base = `/${wsId}/prs/${prId}`;
    await call("PATCH", `${base}/drafts/${byTitle(before, "Goes edited")?.id}`, {
      action: "accept",
      body: "Kept text",
    });

    await setHead(prId, HEAD_B);
    // Before the new head is verified, no line is trusted: the edited draft
    // waits as stale and the untouched ones are gone.
    let now = await drafts(wsId, prId);
    expect(now.map((d) => [d.title, d.stale])).toEqual([["Goes edited", true]]);

    await insertRun(HEAD_B, ["tests"], { tests: checkWith(finding("Stays", 15)) }, 0);
    now = await drafts(wsId, prId);
    expect(now.map((d) => [d.title, d.line, d.stale, d.headSha])).toEqual([
      ["Goes edited", 7, true, HEAD_A],
      ["Stays", 15, false, HEAD_B],
    ]);
    const stale = byTitle(now, "Goes edited");
    expect(stale?.editedBody).toBe("Kept text");
    // A stale draft can be dropped, not posted.
    expect((await call("POST", `${base}/drafts/post`, {})).status).toBe(400);
    expect((await call("PATCH", `${base}/drafts/${stale?.id}`, { action: "reopen" })).status).toBe(
      409,
    );
    expect((await call("PATCH", `${base}/drafts/${stale?.id}`, { action: "drop" })).status).toBe(
      200,
    );
  });

  it("doesn't offer a dropped draft again when the finding comes back", async () => {
    const { wsId, prId } = await insertPr();
    await insertRun(HEAD_A, ["tests"], { tests: checkWith(finding("Nit", 5)) });
    const [d] = await drafts(wsId, prId);
    await call("PATCH", `/${wsId}/prs/${prId}/drafts/${d?.id}`, { action: "drop" });
    await setHead(prId, HEAD_B);
    await insertRun(HEAD_B, ["tests"], { tests: checkWith(finding("Nit", 9)) }, 0);
    const now = await drafts(wsId, prId);
    expect(now.map((x) => [x.status, x.outcome])).toEqual([["dropped", "dropped"]]);
  });
});
