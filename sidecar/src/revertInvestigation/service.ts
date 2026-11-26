import { access } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { prNavTarget } from "../attention/navTarget.ts";
import { raiseAttention, resolveRaisedAttention } from "../attention/raise.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  type Repo,
  type RevertInvestigation,
  repos,
  revertInvestigations,
  workspaceRepoPr,
  workspaceRepos,
  workspaces,
} from "../db/schema.ts";
import { createGitHubClient, type GitHubClient } from "../github/client.ts";
import { readSection, withSection } from "../settings/store.ts";
import { type ClaudeSessionStarter, startClaudeSession } from "../workspaces/claudeSession.ts";
import { defaultGitRunner, type GitRunner } from "../workspaces/git.ts";
import { createWorkspace, getWorkspace, provisionWorkspace } from "../workspaces/service.ts";
import { revertedPrNumber, revertedShaOf } from "./detect.ts";
import { buildInvestigationPrompt, ROOT_CAUSE_FILE } from "./prompt.ts";

/**
 * Looks into reverts of PRs the user shipped. The job finds a revert and asks;
 * a workspace and a Claude Code session start only when the user says so (or
 * `autoStart` is on). The session writes `ROOT_CAUSE_FILE`; a later run of the
 * job sees it and tells the user it is ready.
 */

const SETTINGS_KEY = "revertInvestigation";

export interface RevertInvestigationSettings {
  /** Start the investigation on detection instead of asking first. */
  autoStart: boolean;
}

export async function getRevertInvestigationSettings(): Promise<RevertInvestigationSettings> {
  const stored = await readSection<Partial<RevertInvestigationSettings>>(SETTINGS_KEY);
  return { autoStart: stored?.autoStart === true };
}

export async function saveRevertInvestigationSettings(
  input: RevertInvestigationSettings,
): Promise<RevertInvestigationSettings> {
  const next = { autoStart: input.autoStart };
  return withSection<RevertInvestigationSettings, RevertInvestigationSettings>(
    SETTINGS_KEY,
    () => ({
      next,
      result: next,
    }),
  );
}

const askKey = (id: string) => `revert-investigation:${id}`;
const readyKey = (id: string) => `revert-investigation-ready:${id}`;

function githubFor(config: Config, deps: StartDeps): GitHubClient | null {
  if (deps.github) return deps.github;
  const token = config.secrets?.githubToken;
  return token ? createGitHubClient(config, token) : null;
}

function repoLabel(repo: Pick<Repo, "owner" | "repo">): string {
  return `${repo.owner}/${repo.repo}`;
}

/**
 * Deploy and monitoring notes a ship stream recorded for this PR. Nothing
 * records them yet; this is where that lands, and the seed already carries
 * whatever it returns.
 */
export async function deployNotesFor(
  _db: Db,
  _repo: Repo,
  _originalNumber: number,
): Promise<string | null> {
  return null;
}

interface Candidate {
  originalNumber: number;
  kind: "pr" | "commit";
  ref: string;
  title: string;
  url: string;
  text: string;
}

/** The PR's summary when the user wrote it or a workspace of theirs opened it, else null. */
async function findUsersPr(
  db: Db,
  gh: GitHubClient,
  viewer: string,
  repo: Repo,
  number: number,
): Promise<{ title: string; url: string } | null> {
  const pr = await gh.prSummary(repo.owner, repo.repo, number);
  if (pr.author.toLowerCase() === viewer.toLowerCase()) return pr;
  const [shipped] = await db
    .select({ id: workspaceRepoPr.id })
    .from(workspaceRepoPr)
    .innerJoin(workspaceRepos, eq(workspaceRepos.id, workspaceRepoPr.workspaceRepoId))
    .where(and(eq(workspaceRepos.repoId, repo.id), eq(workspaceRepoPr.prNumber, number)))
    .limit(1);
  return shipped ? pr : null;
}

async function findCandidates(gh: GitHubClient, repo: Repo, since: Date): Promise<Candidate[]> {
  const found = new Map<number, Candidate>();

  for (const pr of await gh.mergedRevertPrs(repo.owner, repo.repo, since)) {
    const original = revertedPrNumber(pr, repo.owner, repo.repo);
    if (original && !found.has(original)) {
      found.set(original, {
        originalNumber: original,
        kind: "pr",
        ref: String(pr.number),
        title: pr.title,
        url: pr.url,
        text: pr.body,
      });
    }
  }

  const branch = repo.defaultBranch ?? (await gh.defaultBranch(repo.owner, repo.repo));
  for (const commit of await gh.recentCommits(repo.owner, repo.repo, branch, since)) {
    const sha = revertedShaOf(commit.message);
    if (!sha) continue;
    const [original] = await gh.prNumbersForCommit(repo.owner, repo.repo, sha);
    if (original && !found.has(original)) {
      found.set(original, {
        originalNumber: original,
        kind: "commit",
        ref: commit.sha,
        title: commit.message.split("\n")[0] ?? "",
        url: commit.url,
        text: commit.message,
      });
    }
  }
  return [...found.values()];
}

export interface DetectResult {
  detected: number;
  errors: string[];
}

/** Records the reverts of the user's PRs, in registered repos, merged since `since`. */
export async function detectReverts(
  db: Db,
  config: Config,
  since: Date,
  deps: StartDeps = {},
): Promise<DetectResult> {
  const gh = githubFor(config, deps);
  if (!gh) return { detected: 0, errors: ["no GitHub token configured"] };
  const { login } = await gh.viewer();
  const { autoStart } = await getRevertInvestigationSettings();
  const result: DetectResult = { detected: 0, errors: [] };

  for (const repo of await db.select().from(repos)) {
    let candidates: Candidate[];
    try {
      candidates = await findCandidates(gh, repo, since);
    } catch (e) {
      result.errors.push(`${repoLabel(repo)}: ${errorMessage(e)}`);
      continue;
    }
    // Per candidate, so one PR GitHub won't return doesn't hide the rest.
    for (const candidate of candidates) {
      try {
        if (await recordCandidate(db, config, gh, login, repo, candidate, autoStart, deps)) {
          result.detected++;
        }
      } catch (e) {
        result.errors.push(`${repoLabel(repo)}#${candidate.originalNumber}: ${errorMessage(e)}`);
      }
    }
  }
  return result;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Records one revert and asks about it (or starts it). Returns whether it was new. */
async function recordCandidate(
  db: Db,
  config: Config,
  gh: GitHubClient,
  login: string,
  repo: Repo,
  candidate: Candidate,
  autoStart: boolean,
  deps: StartDeps,
): Promise<boolean> {
  const [known] = await db
    .select({ id: revertInvestigations.id })
    .from(revertInvestigations)
    .where(
      and(
        eq(revertInvestigations.repoId, repo.id),
        eq(revertInvestigations.originalNumber, candidate.originalNumber),
      ),
    );
  if (known) return false;
  const originalPr = await findUsersPr(db, gh, login, repo, candidate.originalNumber);
  if (!originalPr) return false;
  const [row] = await db
    .insert(revertInvestigations)
    .values({
      repoId: repo.id,
      originalNumber: candidate.originalNumber,
      originalTitle: originalPr.title,
      originalUrl: originalPr.url,
      revertKind: candidate.kind,
      revertRef: candidate.ref,
      revertTitle: candidate.title,
      revertUrl: candidate.url,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return false;
  try {
    const started = autoStart ? await startInvestigation(db, config, row.id, deps) : null;
    // A start that failed falls back to asking, so the revert isn't left with no item.
    if (!started || "error" in started) await askToInvestigate(db, repo, row);
  } catch (e) {
    // Dropped so the next run finds it again; a row with no item would be skipped as known.
    await db.delete(revertInvestigations).where(eq(revertInvestigations.id, row.id));
    throw e;
  }
  return true;
}

async function askToInvestigate(db: Db, repo: Repo, row: RevertInvestigation): Promise<void> {
  await raiseAttention(db, {
    category: "build",
    kind: "action",
    title: `Revert of ${repoLabel(repo)}#${row.originalNumber} detected — start investigation?`,
    body: "Ask Yarvis to start the revert investigation. It opens a workspace and a Claude Code session that writes up what was missed. Nothing is posted anywhere.",
    navTarget: prNavTarget({
      provider: "github",
      owner: repo.owner,
      repo: repo.repo,
      number: row.originalNumber,
    }),
    dedupeKey: askKey(row.id),
  });
}

export interface StartDeps {
  /** Overrides the GitHub client built from the configured token. */
  github?: GitHubClient;
  runner?: GitRunner;
  startSession?: ClaudeSessionStarter;
  remoteControl?: boolean;
}

/**
 * Opens a workspace on the repo's default branch and starts a session seeded
 * with the investigation brief. The session has no PR to push to: the brief
 * forbids pushing and commenting, and the workspace is cut from the default
 * branch with no branch of its own to publish.
 */
export async function startInvestigation(
  db: Db,
  config: Config,
  id: string,
  deps: StartDeps = {},
): Promise<{ workspaceId: string } | { error: string }> {
  const [claimed] = await db
    .update(revertInvestigations)
    .set({ status: "started", startedAt: new Date() })
    .where(and(eq(revertInvestigations.id, id), eq(revertInvestigations.status, "detected")))
    .returning();
  if (!claimed) return { error: "not found, or already started or dismissed" };

  let workspaceId: string;
  try {
    const [repo] = await db.select().from(repos).where(eq(repos.id, claimed.repoId));
    if (!repo) throw new Error("repo no longer registered");
    const brief = buildInvestigationPrompt({
      repo: repoLabel(repo),
      originalNumber: claimed.originalNumber,
      originalTitle: claimed.originalTitle,
      originalUrl: claimed.originalUrl,
      revertKind: claimed.revertKind,
      revertRef: claimed.revertRef,
      revertTitle: claimed.revertTitle,
      revertUrl: claimed.revertUrl,
      revertText: await fetchRevertText(githubFor(config, deps), repo, claimed),
      deployNotes: await deployNotesFor(db, repo, claimed.originalNumber),
    });
    const ws = await createWorkspace(db, config, {
      name: `Revert investigation: ${repoLabel(repo)}#${claimed.originalNumber}`,
      repoIds: [repo.id],
      brief,
    });
    await db
      .update(revertInvestigations)
      .set({ workspaceId: ws.id })
      .where(eq(revertInvestigations.id, id));
    // Provisioning records its failure on the workspace instead of throwing.
    await provisionWorkspace(db, ws.id, () => undefined, {
      runner: deps.runner ?? defaultGitRunner,
      startSession: deps.startSession ?? startClaudeSession,
      remoteControl: deps.remoteControl ?? false,
    });
    const detail = await getWorkspace(db, ws.id);
    if (detail?.status !== "active") {
      throw new Error(`workspace ${ws.name} did not provision; archive it and try again`);
    }
    workspaceId = ws.id;
  } catch (e) {
    // The workspace, if one was made, stays in the list for the user to archive.
    await db
      .update(revertInvestigations)
      .set({ status: "detected", startedAt: null, workspaceId: null })
      .where(and(eq(revertInvestigations.id, id), eq(revertInvestigations.status, "started")));
    return { error: errorMessage(e) };
  }
  await resolveRaisedAttention(db, askKey(id));
  return { workspaceId };
}

/** The revert's body or message, read again so the row never stores text a model will later read. */
async function fetchRevertText(
  gh: GitHubClient | null,
  repo: Repo,
  row: RevertInvestigation,
): Promise<string> {
  if (!gh) return "";
  if (row.revertKind === "commit") return gh.commitMessage(repo.owner, repo.repo, row.revertRef);
  const detail = await gh.prDetail(repo.owner, repo.repo, Number(row.revertRef));
  return detail.body ?? "";
}

export async function dismissInvestigation(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .update(revertInvestigations)
    .set({ status: "dismissed" })
    .where(and(eq(revertInvestigations.id, id), eq(revertInvestigations.status, "detected")))
    .returning();
  if (row) await resolveRaisedAttention(db, askKey(id));
  return Boolean(row);
}

export async function listInvestigations(db: Db): Promise<RevertInvestigation[]> {
  return db.select().from(revertInvestigations);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Tells the user about each started investigation whose session has written its root-cause file. */
export async function settleFinished(db: Db): Promise<number> {
  const started = await db
    .select({ row: revertInvestigations, rootPath: workspaces.rootPath, repo: repos })
    .from(revertInvestigations)
    .innerJoin(workspaces, eq(workspaces.id, revertInvestigations.workspaceId))
    .innerJoin(repos, eq(repos.id, revertInvestigations.repoId))
    .where(eq(revertInvestigations.status, "started"));
  let ready = 0;
  for (const { row, rootPath, repo } of started) {
    if (!row.workspaceId || !(await exists(join(rootPath, ROOT_CAUSE_FILE)))) continue;
    await raiseAttention(db, {
      category: "build",
      kind: "message",
      title: `Revert investigation for ${repoLabel(repo)}#${row.originalNumber} is ready`,
      body: `The write-up is in the workspace at ${ROOT_CAUSE_FILE}.`,
      navTarget: { type: "workspace", workspaceId: row.workspaceId },
      dedupeKey: readyKey(row.id),
    });
    await db
      .update(revertInvestigations)
      .set({ status: "ready", readyAt: new Date() })
      .where(and(eq(revertInvestigations.id, row.id), eq(revertInvestigations.status, "started")));
    ready++;
  }
  return ready;
}
