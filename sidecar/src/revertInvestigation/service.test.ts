import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { listAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import type { GitHubClient } from "../github/client.ts";
import type { GitRunner } from "../workspaces/git.ts";
import { createRepo } from "../workspaces/service.ts";
import {
  detectReverts,
  dismissInvestigation,
  saveRevertInvestigationSettings,
  settleFinished,
  startInvestigation,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-revert-test-"));
const config = { workspacesRoot, secrets: { githubToken: "t" } } as unknown as Config;

const okRunner: GitRunner = async (args) => {
  if (args[0] === "ls-remote")
    return { stdout: "ref: refs/heads/main\tHEAD\n", stderr: "", exitCode: 0 };
  if (args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 1 };
  return { stdout: "", stderr: "", exitCode: 0 };
};

function fakeGitHub(author = "octocat", over: Record<string, unknown> = {}): GitHubClient {
  return {
    viewer: async () => ({ login: "octocat" }),
    mergedRevertPrs: async () => [
      {
        number: 15,
        title: 'Revert "Add x"',
        body: "Reverts acme/widget#12",
        url: "https://github.com/acme/widget/pull/15",
        mergedAt: new Date().toISOString(),
      },
    ],
    recentCommits: async () => [],
    prNumbersForCommit: async () => [],
    defaultBranch: async () => "main",
    commitMessage: async () => "",
    prDetail: async () => ({ body: "Reverts acme/widget#12" }),
    prSummary: async () => ({
      number: 12,
      title: "Add x",
      url: "https://github.com/acme/widget/pull/12",
      owner: "acme",
      repo: "widget",
      author,
    }),
    ...over,
  } as unknown as GitHubClient;
}

const since = new Date(Date.now() - 86_400_000);
const started: string[] = [];
const deps = (github = fakeGitHub()) => ({
  github,
  runner: okRunner,
  startSession: async (input: { workspaceId: string }) => {
    started.push(input.workspaceId);
    return { sessionKey: `ws-claude:${input.workspaceId}` };
  },
});

beforeEach(async () => {
  started.length = 0;
  await sql`TRUNCATE revert_investigations, attention_items, workspaces, repos RESTART IDENTITY CASCADE`;
  await createRepo(db, config, {
    name: "widget",
    cloneUrl: "https://github.com/acme/widget.git",
  } as never).catch(async () => {
    await sql`INSERT INTO repos (name, owner, repo, clone_url, primary_clone_path)
              VALUES ('widget', 'acme', 'widget', 'https://github.com/acme/widget.git', ${join(workspacesRoot, "clone")})`;
  });
});

afterAll(async () => {
  await sql.end();
});

describe("detectReverts", () => {
  it("asks first and records each revert once", async () => {
    const first = await detectReverts(db, config, since, deps());
    const second = await detectReverts(db, config, since, deps());
    expect(first.detected).toBe(1);
    expect(second.detected).toBe(0);
    const [row] = await db.select().from(schema.revertInvestigations);
    expect(row?.status).toBe("detected");
    expect(started).toEqual([]);
    const items = await listAttention(db, { status: "pending" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "action", category: "build" });
    expect(items[0]?.title).toBe("Revert of acme/widget#12 detected — start investigation?");
  });

  it("skips a PR the user didn't write", async () => {
    const result = await detectReverts(db, config, since, deps(fakeGitHub("someone-else")));
    expect(result.detected).toBe(0);
  });
});

describe("startInvestigation", () => {
  it("opens a workspace, starts a session, and clears the question", async () => {
    await detectReverts(db, config, since, deps());
    const [row] = await db.select().from(schema.revertInvestigations);
    const result = await startInvestigation(db, config, row?.id as string, deps());
    expect("workspaceId" in result).toBe(true);
    const [after] = await db.select().from(schema.revertInvestigations);
    expect(after?.status).toBe("started");
    expect(started).toHaveLength(1);
    expect(await listAttention(db, { status: "pending" })).toHaveLength(0);
    expect(await startInvestigation(db, config, row?.id as string, deps())).toHaveProperty("error");
  });

  it("can be dismissed instead", async () => {
    await detectReverts(db, config, since, deps());
    const [row] = await db.select().from(schema.revertInvestigations);
    expect(await dismissInvestigation(db, row?.id as string)).toBe(true);
    expect(await startInvestigation(db, config, row?.id as string, deps())).toHaveProperty("error");
  });
});

describe("settleFinished", () => {
  it("raises a note once the root-cause file exists", async () => {
    await detectReverts(db, config, since, deps());
    const [row] = await db.select().from(schema.revertInvestigations);
    await startInvestigation(db, config, row?.id as string, deps());
    expect(await settleFinished(db)).toBe(0);

    const [after] = await db.select().from(schema.revertInvestigations);
    const [ws] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, after?.workspaceId as string));
    const file = join(ws?.rootPath as string, ".yarvis/root-cause.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "# Root cause");

    expect(await settleFinished(db)).toBe(1);
    expect(await settleFinished(db)).toBe(0);
    const items = await listAttention(db, { status: "pending" });
    expect(items[0]).toMatchObject({ kind: "message", category: "build" });
  });
});

describe("commit reverts", () => {
  const commitGithub = () =>
    fakeGitHub("octocat", {
      mergedRevertPrs: async () => [],
      recentCommits: async () => [
        {
          sha: "abc123abc123",
          message: 'Revert "Add x"\n\nThis reverts commit 0123abcdef01.',
          url: "https://github.com/acme/widget/commit/abc123abc123",
        },
      ],
      prNumbersForCommit: async () => [12],
    });

  it("records a revert commit against the PR it undid", async () => {
    const result = await detectReverts(db, config, since, deps(commitGithub()));
    expect(result.detected).toBe(1);
    const [row] = await db.select().from(schema.revertInvestigations);
    expect(row).toMatchObject({
      revertKind: "commit",
      revertRef: "abc123abc123",
      originalNumber: 12,
    });
  });

  it("records one row when a revert PR and a revert commit name the same PR", async () => {
    const both = fakeGitHub("octocat", {
      recentCommits: async () => [
        { sha: "abc123abc123", message: "This reverts commit 0123abcdef01.", url: "u" },
      ],
      prNumbersForCommit: async () => [12],
    });
    await detectReverts(db, config, since, deps(both));
    expect(await db.select().from(schema.revertInvestigations)).toHaveLength(1);
  });
});

describe("autoStart", () => {
  it("starts straight away and raises no question", async () => {
    await saveRevertInvestigationSettings({ autoStart: true });
    try {
      await detectReverts(db, config, since, deps());
      const [row] = await db.select().from(schema.revertInvestigations);
      expect(row?.status).toBe("started");
      expect(started).toHaveLength(1);
      expect(await listAttention(db, { status: "pending" })).toHaveLength(0);
    } finally {
      await saveRevertInvestigationSettings({ autoStart: false });
    }
  });
});

describe("a start that fails", () => {
  it("goes back to detected so it can be retried", async () => {
    await detectReverts(db, config, since, deps());
    const [row] = await db.select().from(schema.revertInvestigations);
    const failing = {
      ...deps(),
      runner: (async () => ({ stdout: "", stderr: "boom", exitCode: 1 })) as GitRunner,
    };
    const result = await startInvestigation(db, config, row?.id as string, failing);
    expect(result).toHaveProperty("error");
    const [after] = await db.select().from(schema.revertInvestigations);
    expect(after).toMatchObject({ status: "detected", workspaceId: null });
    expect(await listAttention(db, { status: "pending" })).toHaveLength(1);
    expect(await startInvestigation(db, config, row?.id as string, deps())).toHaveProperty(
      "workspaceId",
    );
  });
});
