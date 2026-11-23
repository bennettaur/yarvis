import { inArray } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { reviewPreps } from "../db/schema.ts";
import { createGitHubClient, type ReviewCandidate } from "../github/client.ts";
import { getGithubPrConfig } from "../github/config.ts";
import { describeError } from "../llm/errors.ts";
import { refKey } from "../pr/types.ts";
import { listReviewWorkspaces } from "../reviewWorkspaces/service.ts";

/**
 * The PRs the review scout chooses from: review requests addressed to the
 * user (the PRs tab's "Needs review" search), and open PRs in repos, by
 * people, or requested of teams the scout was told to watch. Each comes with
 * why it was found and what deciding whether to review it needs: draft,
 * approvals, size, the user's own last review, and whether it is already in
 * a review workspace. Which to pick is the scout's call, by its prompt.
 */

export interface CandidateQuery {
  /** `owner/repo`. */
  repos?: string[];
  /** GitHub logins. */
  authors?: string[];
  /** `org/team-slug`. */
  teams?: string[];
}

export type CandidateReason = "review-requested" | "watched-repo" | "watched-author" | "team";

export interface Candidate {
  pr: string;
  owner: string;
  repo: string;
  number: number;
  /** Written by the PR's author. */
  title: string;
  author: string;
  url: string;
  draft: boolean;
  reasons: CandidateReason[];
  approvals: number;
  changesRequested: number;
  reviewDecision: ReviewCandidate["reviewDecision"];
  changedLines: number;
  changedFiles: number;
  /** The user's own latest verdict on it, if they gave one. */
  myLastReview: string | null;
  inReviewWorkspace: boolean;
  /** How review prep last left it, if it prepared it. */
  prepState: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateSearch {
  viewer(): Promise<{ login: string }>;
  searchReviewCandidates(query: string, viewer: string, limit?: number): Promise<ReviewCandidate[]>;
}

/** Most PRs one call returns; the scout picks a handful. */
const MAX_CANDIDATES = 50;

export async function findReviewCandidates(
  db: Db,
  config: Config,
  query: CandidateQuery,
  search?: CandidateSearch,
): Promise<{ candidates: Candidate[]; unavailable: string[] }> {
  let client = search;
  if (!client) {
    const token = config.secrets?.githubToken;
    if (!token) return { candidates: [], unavailable: ["github (not signed in)"] };
    client = createGitHubClient(config, token);
  }
  const { login } = await client.viewer();
  const { reviewQuery } = await getGithubPrConfig();
  const open = "is:pr is:open archived:false";
  const searches: { reason: CandidateReason; q: string }[] = [
    { reason: "review-requested", q: reviewQuery },
    ...(query.repos ?? []).map((r) => ({
      reason: "watched-repo" as const,
      q: `${open} repo:${r} -author:@me`,
    })),
    ...(query.authors ?? []).map((a) => ({
      reason: "watched-author" as const,
      q: `${open} author:${a}`,
    })),
    ...(query.teams ?? []).map((t) => ({
      reason: "team" as const,
      q: `${open} team-review-requested:${t}`,
    })),
  ];

  const unavailable: string[] = [];
  const results = await Promise.all(
    searches.map(async ({ reason, q }) => {
      try {
        return { reason, prs: await client.searchReviewCandidates(q, login) };
      } catch (e) {
        console.error(`[review-prep] candidate search failed (${q}):`, describeError(e));
        unavailable.push(`the ${reason} search`);
        return { reason, prs: [] };
      }
    }),
  );

  const byKey = new Map<string, Candidate>();
  for (const { reason, prs } of results) {
    for (const found of prs) {
      const { summary } = found;
      if (summary.author === login || summary.state !== "open") continue;
      const key = refKey({
        provider: "github",
        owner: summary.owner,
        repo: summary.repo,
        number: summary.number,
      });
      const seen = byKey.get(key);
      if (seen) {
        if (!seen.reasons.includes(reason)) seen.reasons.push(reason);
        continue;
      }
      byKey.set(key, {
        pr: `${summary.owner}/${summary.repo}#${summary.number}`,
        owner: summary.owner,
        repo: summary.repo,
        number: summary.number,
        title: summary.title,
        author: summary.author,
        url: summary.url,
        draft: summary.draft,
        reasons: [reason],
        approvals: found.approvals,
        changesRequested: found.changesRequested,
        reviewDecision: found.reviewDecision,
        changedLines: found.changedLines,
        changedFiles: found.changedFiles,
        myLastReview: found.myReviewStates.at(-1) ?? null,
        inReviewWorkspace: false,
        prepState: null,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      });
    }
  }

  const keys = [...byKey.keys()];
  if (keys.length > 0) {
    const inWorkspace = new Set(
      (await listReviewWorkspaces(db))
        .filter((ws) => ws.status === "active")
        .flatMap((ws) => ws.prs.map((pr) => pr.refKey)),
    );
    const preps = await db
      .select({ refKey: reviewPreps.refKey, state: reviewPreps.state })
      .from(reviewPreps)
      .where(inArray(reviewPreps.refKey, keys));
    const prepState = new Map(preps.map((p) => [p.refKey, p.state]));
    for (const [key, candidate] of byKey) {
      candidate.inReviewWorkspace = inWorkspace.has(key);
      candidate.prepState = prepState.get(key) ?? null;
    }
  }

  const candidates = [...byKey.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CANDIDATES);
  return { candidates, unavailable };
}
