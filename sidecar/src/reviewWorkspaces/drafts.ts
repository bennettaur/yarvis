import { and, eq, inArray, isNull } from "drizzle-orm";
import { AzureDevOpsClient, isAllowedAzureOrgUrl, orgFromOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type ReviewDraftRow, type ReviewWorkspacePr, reviewDrafts } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import { createGitHubClient, reviewExternalId } from "../github/client.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { type SeenCommits, seenMarkInput } from "../pr/reviewMarks.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import { CHECKLIST_ENTRIES, reportAtHead } from "./checklist.ts";
import { markReviewed } from "./reviewMarks.ts";
import { getReviewPr, type ReviewDeps, ReviewWorkspaceError, reviewDiff } from "./service.ts";
import { CHECK_SECTIONS, type VerificationReport } from "./verification.ts";

/** The source of drafts made from the verification report's findings. */
export const VERIFICATION_DRAFT_SOURCE = "verification";

/** GitHub's own cap on a comment body, and on a review's. */
export const MAX_DRAFT_BODY_CHARS = 65_536;

/**
 * One PR's drafts change one writer at a time in this sidecar, so a sync
 * can't delete or rewrite a draft the reviewer is answering, and two clicks
 * can't post the same drafts twice. Each write also re-checks the row's
 * status, which covers a second app instance on the same database except for
 * two posts at once.
 */
const draftLock = createKeyedLock();

/** One comment a source proposes. */
export interface DraftInput {
  /**
   * The same problem's key on every run of the source, so a run on another
   * head updates its draft instead of adding a second. Leave the line out of
   * it: lines move when commits are pushed.
   */
  sourceKey: string;
  /** Where in the source it came from, shown beside the draft. */
  label: string;
  path: string;
  line: number;
  title: string;
  /** The comment as it would post. Model-written text must already be made safe to post. */
  body: string;
}

const LIVE = ["open", "accepted"] as const;

/**
 * Replaces one source's drafts on a PR with what it reports at `headSha`, and
 * is how any source adds drafts. A draft still reported moves to its new line
 * and text, and an accepted one whose text or line changed goes back to
 * undecided, since the reviewer never saw it that way. One the reviewer
 * dropped or posted is left alone, so it isn't offered again. A draft no
 * longer reported is deleted while untouched, and marked stale once the
 * reviewer edited or accepted it, so their work isn't lost.
 */
export function syncReviewDrafts(
  db: Db,
  input: { refKey: string; source: string; headSha: string; drafts: DraftInput[] },
): Promise<void> {
  return draftLock(input.refKey, () => syncLocked(db, input));
}

async function syncLocked(
  db: Db,
  input: { refKey: string; source: string; headSha: string; drafts: DraftInput[] },
): Promise<void> {
  const wanted = new Map(input.drafts.map((d) => [d.sourceKey, d]));
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(reviewDrafts)
      .where(and(eq(reviewDrafts.refKey, input.refKey), eq(reviewDrafts.source, input.source)));
    const now = new Date();
    for (const row of existing) {
      const draft = wanted.get(row.sourceKey);
      wanted.delete(row.sourceKey);
      if (row.status !== "open" && row.status !== "accepted") continue;
      const stillLive = and(eq(reviewDrafts.id, row.id), inArray(reviewDrafts.status, LIVE));
      if (draft) {
        const moved =
          row.path !== draft.path ||
          row.line !== draft.line ||
          row.headSha !== input.headSha ||
          row.body !== draft.body;
        if (!moved && !row.stale && row.label === draft.label && row.title === draft.title) {
          continue;
        }
        await tx
          .update(reviewDrafts)
          .set({
            label: draft.label,
            path: draft.path,
            line: draft.line,
            title: draft.title,
            body: draft.body,
            headSha: input.headSha,
            stale: false,
            ...(moved && row.status === "accepted" && { status: "open", outcome: null }),
            updatedAt: now,
          })
          .where(stillLive);
      } else if (row.status === "open" && row.editedBody === null) {
        await tx
          .delete(reviewDrafts)
          .where(and(stillLive, eq(reviewDrafts.status, "open"), isNull(reviewDrafts.editedBody)));
      } else if (!row.stale) {
        await tx.update(reviewDrafts).set({ stale: true, updatedAt: now }).where(stillLive);
      }
    }
    if (wanted.size > 0) {
      await tx
        .insert(reviewDrafts)
        .values(
          [...wanted.values()].map((d) => ({
            ...d,
            refKey: input.refKey,
            source: input.source,
            headSha: input.headSha,
          })),
        )
        // A second app instance's sync inserted it first.
        .onConflictDoNothing();
    }
  });
}

/**
 * Mentions as plain text: a zero-width space after the `@` keeps GitHub from
 * notifying anyone, or a bot from reading a command addressed to it.
 */
const unmention = (text: string) => text.replace(/@(?=[\w-])/g, "@\u200b");

/** Every line break as `\n`, so quoting each line leaves none that starts unquoted. */
const oneKindOfBreak = (text: string) => text.replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n");

/**
 * A finding as a comment: its title, then what the report said, quoted, and
 * marked as coming from the report. The same format as the frontend's
 * `findingCommentBody`. The text is model-written from the PR's code, so
 * mentions are broken and the title is kept to one line: posted under the
 * reviewer's account, a `/approve` line or an `@bot` would carry their
 * authority.
 */
export function draftCommentBody(finding: {
  title: string;
  detail?: string;
  severity?: string;
  label: string;
}): string {
  const tag = finding.severity ? `${finding.label}, ${finding.severity}` : finding.label;
  const title = unmention(finding.title).replace(/\s+/g, " ").trim();
  const head = `**${title}** (verification report: ${tag})`;
  if (!finding.detail?.trim()) return head;
  const quoted = oneKindOfBreak(unmention(finding.detail))
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${head}\n\n${quoted}`;
}

const FLAG_LABEL = "Looks off";
const CLAIM_LABEL = {
  partial: "partial",
  missing: "missing",
  contradicted: "contradicted",
} as const;

const titleKey = (title: string) => title.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * A draft for each must-read flag, risk concern, unmet claim, unfinished
 * piece of work and check finding in `report` that cites a line. The same
 * set the diff's report strip lists.
 */
export function verificationDrafts(report: VerificationReport): DraftInput[] {
  const drafts: DraftInput[] = [];
  const add = (
    kind: string,
    item: { path?: string; line?: number; title: string; detail?: string; severity?: string },
    label: string,
  ) => {
    if (!item.path || !item.line) return;
    drafts.push({
      sourceKey: `${kind}:${item.path}:${titleKey(item.title)}`,
      label,
      path: item.path,
      line: item.line,
      title: item.title,
      body: draftCommentBody({ ...item, label }),
    });
  };
  for (const m of report.mustRead ?? []) {
    for (const flag of m.flags ?? []) {
      add("flag", { path: m.path, line: flag.line, title: flag.note }, FLAG_LABEL);
    }
  }
  for (const c of report.risk?.concerns ?? []) add("risk", c, CHECKLIST_ENTRIES.risk.label);
  for (const c of report.claims?.items ?? []) {
    if (c.status === "partial" || c.status === "missing" || c.status === "contradicted") {
      add(
        "claim",
        { path: c.path, line: c.line, title: c.claim, detail: c.evidence },
        `Claim ${CLAIM_LABEL[c.status]}`,
      );
    }
  }
  for (const g of report.claims?.gaps ?? []) add("gap", g, "Unfinished work");
  for (const key of CHECK_SECTIONS) {
    for (const f of report[key]?.findings ?? []) add(key, f, CHECKLIST_ENTRIES[key].label);
  }
  // Two items can share a title on one file; the first keeps the key.
  const seen = new Set<string>();
  return drafts.filter((d) => {
    if (seen.has(d.sourceKey)) return false;
    seen.add(d.sourceKey);
    return true;
  });
}

/**
 * Brings the verification drafts in line with the report at the PR's head.
 * Until a section answers at a new head, its drafts count as no longer
 * reported: their lines were for other code.
 */
export async function syncVerificationDrafts(db: Db, pr: ReviewWorkspacePr): Promise<void> {
  if (!pr.headSha) return;
  const report = await reportAtHead(db, pr);
  await syncReviewDrafts(db, {
    refKey: pr.refKey,
    source: VERIFICATION_DRAFT_SOURCE,
    headSha: pr.headSha,
    drafts: report ? verificationDrafts(report) : [],
  });
}

/** A PR's drafts, by file and line. */
export function listReviewDrafts(db: Db, prRefKey: string): Promise<ReviewDraftRow[]> {
  return db
    .select()
    .from(reviewDrafts)
    .where(eq(reviewDrafts.refKey, prRefKey))
    .orderBy(reviewDrafts.path, reviewDrafts.line, reviewDrafts.createdAt);
}

export type DraftAction =
  | { action: "accept"; body?: string }
  | { action: "drop" }
  | { action: "reopen" };

/**
 * Records the reviewer's answer to a draft. Accepting with text that differs
 * from the proposal counts as an edit. A posted draft can't change, a stale
 * one can only be dropped (its line may point at other code now), and only an
 * accepted one can be reopened.
 */
export function answerReviewDraft(
  db: Db,
  prRefKey: string,
  draftId: string,
  answer: DraftAction,
): Promise<ReviewDraftRow> {
  return draftLock(prRefKey, async () => {
    const [row] = await db
      .select()
      .from(reviewDrafts)
      .where(and(eq(reviewDrafts.id, draftId), eq(reviewDrafts.refKey, prRefKey)));
    if (!row) throw new ReviewWorkspaceError("draft not found", 404);
    if (row.status === "posted") throw new ReviewWorkspaceError("draft already posted", 409);
    if (row.stale && answer.action !== "drop") {
      throw new ReviewWorkspaceError("the finding is gone from the latest verification", 409);
    }
    let set: Partial<ReviewDraftRow>;
    if (answer.action === "accept") {
      const text = answer.body?.trim() ? answer.body : (row.editedBody ?? row.body);
      const edited = text.trim() !== row.body.trim();
      set = {
        status: "accepted",
        outcome: edited ? "edited" : "accepted",
        editedBody: edited ? text : null,
      };
    } else if (answer.action === "drop") {
      set = { status: "dropped", outcome: "dropped" };
    } else {
      if (row.status !== "accepted") {
        throw new ReviewWorkspaceError("only an accepted draft can be reopened", 409);
      }
      set = { status: "open", outcome: null };
    }
    const [updated] = await db
      .update(reviewDrafts)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(reviewDrafts.id, row.id), inArray(reviewDrafts.status, LIVE)))
      .returning();
    if (!updated) throw new ReviewWorkspaceError("draft not found", 404);
    return updated;
  });
}

/** One accepted draft, as it goes to the provider. */
export interface OutgoingDraft {
  id: string;
  path: string;
  line: number;
  body: string;
  /** False when the line is outside the diff, where GitHub takes no line comment. */
  inDiff: boolean;
}

export interface DraftPostResult {
  /** Drafts that reached the provider, even when a later one failed. */
  posted: string[];
  error?: string;
  /** GitHub's review id, to match against the review sync. */
  reviewNodeId?: string | null;
}

/** Sends accepted drafts to the PR's provider. Replaced in tests. */
export type DraftPoster = (
  ref: PrRef,
  review: { headSha: string; summary: string; drafts: OutgoingDraft[] },
) => Promise<DraftPostResult>;

/**
 * The lines of the new file a patch shows, added or unchanged: the lines
 * GitHub takes a comment on.
 */
export function rightLinesInPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (text.startsWith("+") || text.startsWith(" ")) lines.add(next++);
    else if (!text.startsWith("-") && !text.startsWith("\\")) inHunk = false;
  }
  return lines;
}

/**
 * Accepted drafts as they go out. `linesByPath` is each file's diff lines on
 * GitHub, or null on a provider that takes a comment on any line.
 */
export function outgoingDrafts(
  accepted: ReviewDraftRow[],
  linesByPath: Map<string, Set<number>> | null,
): OutgoingDraft[] {
  return accepted.map((d) => ({
    id: d.id,
    path: d.path,
    line: d.line,
    body: d.editedBody ?? d.body,
    inDiff: linesByPath === null || (linesByPath.get(d.path)?.has(d.line) ?? false),
  }));
}

/**
 * A path as text in markdown: on one line, without the backticks that would
 * end its code span, and with mentions broken. A PR's author names its files.
 */
const pathText = (path: string) => unmention(path.replace(/[`\p{Cc}]/gu, "?"));

/**
 * The review's body on GitHub: the reviewer's summary, then each draft whose
 * line is outside the diff, under the file and line it is about.
 */
export function githubReviewBody(summary: string, drafts: OutgoingDraft[]): string {
  return [
    summary.trim(),
    ...drafts
      .filter((d) => !d.inDiff)
      .map((d) => `**\`${pathText(d.path)}\`, line ${d.line}**\n\n${d.body}`),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/**
 * GitHub: one review, all or nothing. Azure: one thread per draft, stopping
 * at the first failure, since Azure has no review that groups comments.
 */
export function defaultDraftPoster(config: Config, fetchImpl?: typeof fetch): DraftPoster {
  return async (ref, { headSha, summary, drafts }) => {
    if (ref.provider === "github") {
      const token = config.secrets.githubToken;
      if (!token) return { posted: [], error: "GitHub isn't signed in." };
      const body = githubReviewBody(summary, drafts);
      if (body.length > MAX_DRAFT_BODY_CHARS) {
        return {
          posted: [],
          error: "The summary and the comments outside the diff are too long for one review.",
        };
      }
      const { nodeId } = await createGitHubClient(config, token, fetchImpl).submitCommentReview(
        ref.owner,
        ref.repo,
        ref.number,
        { commitId: headSha, body, comments: drafts.filter((d) => d.inDiff) },
      );
      return { posted: drafts.map((d) => d.id), reviewNodeId: nodeId };
    }
    const { azureDevopsToken, azureDevopsOrgUrl } = config.secrets;
    if (!azureDevopsToken || !azureDevopsOrgUrl || !isAllowedAzureOrgUrl(azureDevopsOrgUrl)) {
      return { posted: [], error: "Azure DevOps isn't configured." };
    }
    if (orgFromOrgUrl(azureDevopsOrgUrl) !== ref.org) {
      return { posted: [], error: "The pull request belongs to a different Azure organization." };
    }
    const az = new AzureDevOpsClient(azureDevopsToken, azureDevopsOrgUrl);
    const posted: string[] = [];
    for (const d of drafts) {
      try {
        await az.postComment(ref, { path: d.path, line: d.line, body: d.body });
      } catch (e) {
        return { posted, error: e instanceof Error ? e.message : String(e) };
      }
      posted.push(d.id);
    }
    return { posted };
  };
}

/**
 * Posts every accepted draft at the PR's current head as one review, then
 * marks them posted. Only the reviewer's click gets here: nothing a source
 * writes is ever posted on its own. The drafts are synced first, so a draft
 * whose finding moved since the reviewer accepted it isn't sent.
 */
export async function postAcceptedDrafts(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  reviewDeps: ReviewDeps,
  poster: DraftPoster,
  { summary = "", seen = {} }: { summary?: string; seen?: SeenCommits } = {},
): Promise<{ posted: number; error?: string }> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const headSha = pr.headSha;
  if (!headSha) throw new ReviewWorkspaceError("the pull request is still being fetched", 409);
  if (pr.ref.provider === "azure" && summary.trim()) {
    throw new ReviewWorkspaceError("Azure DevOps has no review summary to post it in", 400);
  }
  await syncVerificationDrafts(db, pr);
  return draftLock(pr.refKey, async () => {
    const accepted = (await listReviewDrafts(db, pr.refKey)).filter(
      (d) => d.status === "accepted" && !d.stale && d.headSha === headSha,
    );
    if (accepted.length === 0) throw new ReviewWorkspaceError("no accepted drafts to post", 400);

    let linesByPath: Map<string, Set<number>> | null = null;
    if (pr.ref.provider === "github") {
      linesByPath = new Map();
      for (const path of new Set(accepted.map((d) => d.path))) {
        // Without the diff no line is known to be in it, so the draft goes in
        // the review's body rather than failing the whole review.
        const diff = await reviewDiff(db, config, workspaceId, prId, path, reviewDeps).catch(
          () => null,
        );
        linesByPath.set(path, diff && !diff.tooLarge ? rightLinesInPatch(diff.patch) : new Set());
      }
    }

    let result: DraftPostResult;
    try {
      result = await poster(pr.ref, {
        headSha,
        summary,
        drafts: outgoingDrafts(accepted, linesByPath),
      });
    } catch (e) {
      result = { posted: [], error: e instanceof Error ? e.message : String(e) };
    }
    if (result.posted.length > 0) {
      await db
        .update(reviewDrafts)
        .set({ status: "posted", postedAt: new Date(), updatedAt: new Date() })
        .where(inArray(reviewDrafts.id, result.posted));
      const mark = seenMarkInput(pr.ref, seen, headSha, "review");
      if (mark) await markReviewed(db, config, mark, reviewDeps);
      await emitEvent(db, {
        type: pr.ref.provider === "github" ? "pr.review_commented" : "pr.commented",
        source: pr.ref.provider,
        payload: { ref: refKey(pr.ref), drafts: result.posted.length },
        externalId: result.reviewNodeId ? reviewExternalId(result.reviewNodeId) : undefined,
      });
    }
    return { posted: result.posted.length, ...(result.error && { error: result.error }) };
  });
}
