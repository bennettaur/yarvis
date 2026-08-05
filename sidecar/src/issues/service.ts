import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type IssueFilter,
  type IssueLink,
  type IssueStar,
  issueFilters,
  issueLinks,
  issueStars,
  type Repo,
  repos,
} from "../db/schema.ts";
import type { IssueSummary } from "./types.ts";

/**
 * Local persistence for the Issues integration: which repos to pull issues
 * from, saved searches, stars, and workspace links + local status. Issue
 * content itself is fetched live from the provider, not stored here. Every
 * function is source-agnostic — a ticket is keyed by (provider, sourceKey,
 * externalId).
 */

/** Repos flagged to appear in the Issues dashboard. */
export function listIssueRepos(db: Db): Promise<Repo[]> {
  return db.select().from(repos).where(eq(repos.pullIssues, true)).orderBy(repos.name);
}

/**
 * The registered repo an issue belongs to, matched by its "owner/repo"
 * sourceKey. "Start work" needs this to know which repo to cut a worktree from.
 * Returns undefined if the repo isn't registered (only registered repos can be
 * pulled, so this normally hits).
 */
export function findRepoBySourceKey(db: Db, sourceKey: string): Promise<Repo | undefined> {
  const slash = sourceKey.indexOf("/");
  if (slash < 0) return Promise.resolve(undefined);
  const owner = sourceKey.slice(0, slash);
  const repo = sourceKey.slice(slash + 1);
  return db
    .select()
    .from(repos)
    .where(and(eq(repos.owner, owner), eq(repos.repo, repo)))
    .then((rows) => rows[0]);
}

/**
 * Merges per-repo issue lists newest-first, dropping repos whose fetch rejected
 * so a single failing repo doesn't blank the whole dashboard.
 */
export function mergeIssues(results: PromiseSettledResult<IssueSummary[]>[]): IssueSummary[] {
  const issues = results
    .filter((r): r is PromiseFulfilledResult<IssueSummary[]> => r.status === "fulfilled")
    .flatMap((r) => r.value);
  return issues.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface IssuePromptInput {
  displayId: string;
  title: string;
  url: string | null;
  body: string;
  sourceKey: string;
}

/**
 * Strips characters an issue could use to smuggle hidden instructions into the
 * prompt. "Start work" launches Claude on this content with auto-approved
 * tools, so a malicious issue must not be able to hide directives that a human
 * reviewer wouldn't see on the rendered issue: C0/C1 control codes (tab and
 * newline kept), invisible/zero-width and bidi format characters, HTML comments
 * (invisible in GitHub's rendered view), and whitespace padding.
 */
export function sanitizeIssueText(text: string): string {
  const cleaned = Array.from(text)
    .filter((ch) => !isHiddenChar(ch.codePointAt(0) ?? 0))
    .join("");

  // Both passes repeat to a fixed point, because deleting from the middle of a
  // run of markup can leave a fresh marker behind: "--->->" loses its inner
  // "-->" and closes back up into a live "-->". One pass would hand that to the
  // model. HTML ends a comment with "--!>" as well as "-->", so both spellings
  // count — a comment closed the second way is just as invisible on the rendered
  // issue, and missing it would leak its contents into the prompt as text.
  let withoutComments = cleaned;
  let previous: string;
  do {
    previous = withoutComments;
    withoutComments = withoutComments
      .replace(/<!--[\s\S]*?--!?>/g, "")
      // Whatever marker is still standing is unpaired. Dropping it is what makes
      // sanitizing a composition of sanitized parts safe: an issue's title and
      // body are sanitized separately and then joined, so a lone `<!--` left in
      // the title would pair with a `-->` from the body on the next pass and
      // swallow the description between them. Like the paired strip above, this
      // doesn't spare fenced code, so a ticket demonstrating an HTML comment
      // loses the markers — the right trade for text an auto-approved session
      // reads as instruction.
      .replace(/<!--|--!?>/g, "");
  } while (withoutComments !== previous);

  let fullySanitized = withoutComments;
  let previousSanitized: string;
  do {
    previousSanitized = fullySanitized;
    fullySanitized = fullySanitized.replace(/<!--/g, "").replace(/--!?>/g, "");
  } while (fullySanitized !== previousSanitized);

  return (
    fullySanitized
      // Trailing whitespace (not newlines) and runs of blank lines.
      .replace(/[^\S\n]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * True for characters that render invisibly (or reorder text) and so could hide
 * instructions: C0/C1 control codes (tab and newline excepted), soft hyphen and
 * Arabic letter mark, zero-width and bidi format characters, the word joiner and
 * invisible math operators, and the BOM. Matched by code point rather than a
 * regex of literal invisible characters, which would be unreadable in source.
 */
function isHiddenChar(code: number): boolean {
  if (code < 0x20 && code !== 0x09 && code !== 0x0a) return true; // C0 controls
  if (code >= 0x7f && code <= 0x9f) return true; // DEL + C1 controls
  if (code === 0x00ad || code === 0x061c) return true; // soft hyphen, Arabic letter mark
  if (code >= 0x200b && code <= 0x200f) return true; // zero-width + LRM/RLM
  if (code >= 0x202a && code <= 0x202e) return true; // bidi embeddings/overrides
  if (code >= 0x2060 && code <= 0x2064) return true; // word joiner + invisible operators
  if (code >= 0x2066 && code <= 0x206f) return true; // bidi isolates + deprecated format
  if (code === 0xfeff) return true; // BOM / zero-width no-break space
  return false;
}

/** Builds the initial Claude prompt seeded from an issue's title and body. */
export function buildIssuePrompt(issue: IssuePromptInput): string {
  const lines = [
    `Implement the following ${issue.sourceKey} issue ${issue.displayId}.`,
    "",
    `# ${sanitizeIssueText(issue.title)}`,
    "",
    sanitizeIssueText(issue.body) || "_(no description provided)_",
  ];
  if (issue.url) {
    lines.push("", "---", `Issue: ${issue.url}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The subset of the GitHub client the start-work side effects need. Narrowing
 * to an interface keeps the effect logic testable with a fake client and no DB.
 */
export interface StartWorkSideEffectClient {
  viewer(): Promise<{ login: string }>;
  assignIssue(owner: string, repo: string, number: number, assignees: string[]): Promise<void>;
  ensureLabel(owner: string, repo: string, name: string): Promise<void>;
  addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void>;
}

export interface StartWorkSideEffectOptions {
  assignSelf: boolean;
  applyLabel: boolean;
  label: string;
}

/** Label applied to an issue when work starts (creatable in-repo). Shared by the
 *  issue-view "Start work" route and the chat agent's start_work_on_issue tool
 *  so both entry points label issues identically. */
export const IN_PROGRESS_LABEL = "in progress";

/**
 * Applies the best-effort GitHub side effects of starting work — assign the
 * issue to the viewer and label it in-progress. The workspace + link are the
 * source of truth, so each failed write (e.g. a read-only token) becomes a
 * warning rather than aborting; the returned list is empty on full success.
 */
export async function applyStartWorkSideEffects(
  gh: StartWorkSideEffectClient,
  owner: string,
  repo: string,
  number: number,
  opts: StartWorkSideEffectOptions,
): Promise<string[]> {
  const warnings: string[] = [];
  if (opts.assignSelf) {
    try {
      const { login } = await gh.viewer();
      await gh.assignIssue(owner, repo, number, [login]);
    } catch (e) {
      warnings.push(`could not assign issue: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (opts.applyLabel) {
    try {
      await gh.ensureLabel(owner, repo, opts.label);
      await gh.addLabels(owner, repo, number, [opts.label]);
    } catch (e) {
      warnings.push(`could not label issue: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return warnings;
}

/**
 * Writes the issue prompt into the workspace's `.yarvis/` folder (under the
 * workspace root, outside any repo worktree so it never dirties git status) and
 * returns the absolute path. The terminal launches Claude with this file.
 */
export async function writeIssuePrompt(rootPath: string, prompt: string): Promise<string> {
  const dir = join(rootPath, ".yarvis");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "issue-prompt.md");
  await writeFile(file, prompt, "utf8");
  return file;
}

// --- Saved filters ---

export function listFilters(db: Db, provider: string): Promise<IssueFilter[]> {
  return db
    .select()
    .from(issueFilters)
    .where(eq(issueFilters.provider, provider))
    .orderBy(desc(issueFilters.createdAt));
}

export async function createFilter(
  db: Db,
  provider: string,
  name: string,
  query: string,
): Promise<IssueFilter> {
  const [row] = await db.insert(issueFilters).values({ provider, name, query }).returning();
  return row!;
}

export async function deleteFilter(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(issueFilters)
    .where(eq(issueFilters.id, id))
    .returning({ id: issueFilters.id });
  return deleted.length > 0;
}

// --- Stars ---

export function listStars(db: Db, provider: string): Promise<IssueStar[]> {
  return db
    .select()
    .from(issueStars)
    .where(eq(issueStars.provider, provider))
    .orderBy(desc(issueStars.createdAt));
}

export interface StarInput {
  provider: string;
  sourceKey: string;
  externalId: string;
  title?: string | null;
  url?: string | null;
}

export async function addStar(db: Db, input: StarInput): Promise<void> {
  await db
    .insert(issueStars)
    .values({
      provider: input.provider,
      sourceKey: input.sourceKey,
      externalId: input.externalId,
      title: input.title ?? null,
      url: input.url ?? null,
    })
    .onConflictDoNothing();
}

export async function removeStar(
  db: Db,
  provider: string,
  sourceKey: string,
  externalId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(issueStars)
    .where(
      and(
        eq(issueStars.provider, provider),
        eq(issueStars.sourceKey, sourceKey),
        eq(issueStars.externalId, externalId),
      ),
    )
    .returning({ id: issueStars.id });
  return deleted.length > 0;
}

// --- Workspace links + local status ---

export function listLinks(db: Db, provider: string): Promise<IssueLink[]> {
  return db.select().from(issueLinks).where(eq(issueLinks.provider, provider));
}

/** Issue links attached to a workspace, for its detail view. */
export function listLinksForWorkspace(db: Db, workspaceId: string): Promise<IssueLink[]> {
  return db.select().from(issueLinks).where(eq(issueLinks.workspaceId, workspaceId));
}

/**
 * Detaches an issue from a workspace, scoped so it only removes this
 * workspace's link. Deletes the row outright: an explicit unlink drops the
 * tracked issue rather than orphaning its local status. Returns false if no
 * matching link exists.
 */
export async function deleteLinkForWorkspace(
  db: Db,
  workspaceId: string,
  provider: string,
  sourceKey: string,
  externalId: string,
): Promise<boolean> {
  const rows = await db
    .delete(issueLinks)
    .where(
      and(
        eq(issueLinks.workspaceId, workspaceId),
        eq(issueLinks.provider, provider),
        eq(issueLinks.sourceKey, sourceKey),
        eq(issueLinks.externalId, externalId),
      ),
    )
    .returning({ id: issueLinks.id });
  return rows.length > 0;
}

export interface UpsertLinkInput {
  provider: string;
  sourceKey: string;
  externalId: string;
  title?: string | null;
  url?: string | null;
  workspaceId: string;
  localStatus?: "todo" | "in_progress" | "done";
}

/**
 * Records (or updates) the link between an issue and the workspace opened to
 * work on it, and its local lifecycle status. Idempotent per issue: starting
 * work on an already-linked issue re-points it at the new workspace.
 */
export async function upsertLink(db: Db, input: UpsertLinkInput): Promise<IssueLink> {
  const [row] = await db
    .insert(issueLinks)
    .values({
      provider: input.provider,
      sourceKey: input.sourceKey,
      externalId: input.externalId,
      title: input.title ?? null,
      url: input.url ?? null,
      workspaceId: input.workspaceId,
      localStatus: input.localStatus ?? "in_progress",
    })
    .onConflictDoUpdate({
      target: [issueLinks.provider, issueLinks.sourceKey, issueLinks.externalId],
      set: {
        title: input.title ?? null,
        url: input.url ?? null,
        workspaceId: input.workspaceId,
        localStatus: input.localStatus ?? "in_progress",
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}
