import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { workspaceRepoPr, workspaceRepos } from "../db/schema.ts";
import { createRepo, createWorkspace, getWorkspace } from "../workspaces/service.ts";
import type { PrCodeSource } from "./source.ts";
import type { PrDetail, PrRef } from "./types.ts";
import { startWorkspaceForPr } from "./workspace.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-pr-ws-root-"));

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot,
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};

const ref: PrRef = { provider: "github", owner: "acme", repo: "widget", number: 7 };
const azureRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 9 };

/** A source answering only what the flow reads: the PR's identity and detail. */
function fakeSource(detail: Partial<PrDetail>, prRef: PrRef = ref): PrCodeSource {
  return {
    ref: prRef,
    detail: async () => ({ title: "Rename the API", headRef: "topic", fromFork: false, ...detail }),
  } as unknown as PrCodeSource;
}

/** Records the kick-off instead of provisioning, which would run real git. */
function recordingKickOff() {
  const started: string[] = [];
  return { started, kickOff: (_db: unknown, id: string) => void started.push(id) };
}

const addRepo = (cloneUrl = "git@github.com:acme/widget.git") =>
  createRepo(db, config, { cloneUrl });

beforeEach(async () => {
  await sql`TRUNCATE repos, workspaces, workspace_repos, workspace_repo_pr RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
  rmSync(workspacesRoot, { recursive: true, force: true });
});

describe("startWorkspaceForPr", () => {
  it("creates a workspace on the pull request's branch and starts provisioning", async () => {
    const repo = await addRepo();
    const { started, kickOff } = recordingKickOff();

    const result = await startWorkspaceForPr(db, config, fakeSource({}), { kickOff });

    expect(result.existing).toBe(false);
    expect(result.name).toBe("PR #7 · Rename the API");
    expect(started).toEqual([result.workspaceId]);

    const detail = await getWorkspace(db, result.workspaceId);
    expect(detail?.repos).toHaveLength(1);
    expect(detail?.repos[0]).toMatchObject({
      repoId: repo.id,
      branch: "topic",
      existingBranch: true,
    });
  });

  // The session the workspace opens with is a blank prompt, so nothing is
  // seeded for provisioning to hand an agent.
  it("leaves the workspace without a kick-off prompt", async () => {
    await addRepo();
    const { kickOff } = recordingKickOff();
    const { workspaceId } = await startWorkspaceForPr(db, config, fakeSource({}), { kickOff });
    expect((await getWorkspace(db, workspaceId))?.pendingIssuePrompt).toBeNull();
  });

  it("reuses the workspace the poller has already matched to the pull request", async () => {
    const repo = await addRepo();
    const workspace = await createWorkspace(db, config, {
      name: "Existing",
      repoIds: [repo.id],
      existingBranches: { [repo.id]: "topic" },
    });
    const [wr] = await db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.workspaceId, workspace.id));
    await db.insert(workspaceRepoPr).values({ workspaceRepoId: wr!.id, prNumber: 7 });

    const { started, kickOff } = recordingKickOff();
    const result = await startWorkspaceForPr(db, config, fakeSource({}), { kickOff });

    expect(result).toEqual({ workspaceId: workspace.id, name: "Existing", existing: true });
    expect(started).toEqual([]);
  });

  it("refuses a pull request whose repository is not registered", async () => {
    const { kickOff } = recordingKickOff();
    await expect(startWorkspaceForPr(db, config, fakeSource({}), { kickOff })).rejects.toThrow(
      "not registered",
    );
  });

  // A fork's branch isn't on the registered repo's remote, so provisioning
  // would only fail later with a git error.
  it("refuses a pull request raised from a fork", async () => {
    await addRepo();
    const { kickOff } = recordingKickOff();
    await expect(
      startWorkspaceForPr(db, config, fakeSource({ fromFork: true }), { kickOff }),
    ).rejects.toThrow("comes from a fork");
  });

  // The poller writes the PR cache only for workspaces that are already
  // provisioned, so the cached lookup is blind for the whole of provisioning —
  // the window a second click actually lands in. Git refuses a second worktree
  // on a checked-out branch, so the duplicate would strand in `error`.
  it("does not create a second workspace when started twice before the poller caches the PR", async () => {
    await addRepo();
    const { started, kickOff } = recordingKickOff();

    const first = await startWorkspaceForPr(db, config, fakeSource({}), { kickOff });
    const second = await startWorkspaceForPr(db, config, fakeSource({}), { kickOff });

    expect(second).toEqual({ workspaceId: first.workspaceId, name: first.name, existing: true });
    expect(started).toEqual([first.workspaceId]);
    expect(await db.select().from(workspaceRepos)).toHaveLength(1);
  });

  it("checks out the branch of an Azure pull request, keyed by its id", async () => {
    const repo = await addRepo("https://dev.azure.com/acme/Shop/_git/web");
    const { kickOff } = recordingKickOff();

    const result = await startWorkspaceForPr(db, config, fakeSource({}, azureRef), { kickOff });

    expect(result.name).toBe("PR #9 · Rename the API");
    const detail = await getWorkspace(db, result.workspaceId);
    expect(detail?.repos[0]).toMatchObject({ repoId: repo.id, branch: "topic" });
  });

  it("picks the registered repo the pull request belongs to, not another", async () => {
    await addRepo("git@github.com:acme/other.git");
    const widget = await addRepo();
    const { kickOff } = recordingKickOff();

    const { workspaceId } = await startWorkspaceForPr(db, config, fakeSource({}), { kickOff });

    expect((await getWorkspace(db, workspaceId))?.repos[0]?.repoId).toBe(widget.id);
  });

  it("refuses a pull request whose branch the provider did not report", async () => {
    await addRepo();
    const { kickOff } = recordingKickOff();
    await expect(
      startWorkspaceForPr(db, config, fakeSource({ headRef: "" }), { kickOff }),
    ).rejects.toThrow("could not determine");
  });

  // The branch name comes from the provider and ends up as a git argument.
  it("refuses a branch name git would read as a flag", async () => {
    await addRepo();
    const { kickOff } = recordingKickOff();
    await expect(
      startWorkspaceForPr(db, config, fakeSource({ headRef: "--upload-pack=x" }), { kickOff }),
    ).rejects.toThrow("unsupported branch name");
  });

  it("names a workspace for a PR whose title is empty", async () => {
    await addRepo();
    const { kickOff } = recordingKickOff();
    const result = await startWorkspaceForPr(db, config, fakeSource({ title: "" }), { kickOff });
    expect(result.name).toBe("PR #7");
  });
});
