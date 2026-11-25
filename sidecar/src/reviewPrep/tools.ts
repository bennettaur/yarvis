import { tool } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import { clientError, describeError } from "../llm/errors.ts";
import { githubNameSchema, prNumberSchema } from "../reviewWorkspaces/routes.ts";
import { ReviewWorkspaceError } from "../reviewWorkspaces/service.ts";
import { type CandidateSearch, findReviewCandidates } from "./candidates.ts";
import { defaultPrepDeps, prepReview, type ReviewPrepDeps } from "./service.ts";

/**
 * Finding PRs for the user to review, and getting one ready. Neither posts
 * anything to a PR: no comment, approval or review request.
 */

const ownerRepo = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, "use owner/repo");
const login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "a GitHub login");
const team = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, "use org/team-slug");

export interface ReviewPrepToolDeps {
  search?: CandidateSearch;
  prep?: (db: Db) => ReviewPrepDeps;
}

export function buildReviewPrepTools(db: Db, config: Config, deps: ReviewPrepToolDeps = {}) {
  return {
    find_review_candidates: tool({
      description:
        "Open GitHub pull requests the user might review: review requests addressed to them, plus open PRs in the repos, by the authors, or requested of the teams given. Each comes with why it was found, whether it is a draft, its approvals and change requests, its size, the user's own last review, whether it is already in a review workspace, and how review prep last left it. The user's own PRs are left out. Reads only.",
      inputSchema: z.object({
        repos: z.array(ownerRepo).max(10).optional().describe("Repos to watch, as owner/repo"),
        authors: z.array(login).max(10).optional().describe("GitHub logins whose PRs to include"),
        teams: z
          .array(team)
          .max(5)
          .optional()
          .describe("Teams whose review requests count, as org/team-slug"),
      }),
      execute: async ({ repos, authors, teams }) => {
        try {
          const result = await findReviewCandidates(
            db,
            config,
            { repos, authors, teams },
            deps.search,
          );
          // Titles are the PRs' authors' text, and the scout's picks become
          // reviews a heads-down pass prepares without asking.
          const nonce = newNonce();
          return {
            note: untrustedWarning(nonce, "pr-title"),
            unavailable: result.unavailable,
            candidates: result.candidates.map((c) => ({
              ...c,
              title: fence(c.title, nonce, "pr-title"),
            })),
          };
        } catch (e) {
          console.error("[review-prep] could not find candidates:", describeError(e));
          return { error: clientError(e) };
        }
      },
    }),

    prep_pr_review: tool({
      description:
        "Get a GitHub pull request ready for the user to review: open a review workspace for it (or use the one it is already in; a layer of a stack joins the workspace review prep opened for the stack), run the verification report, and once that ends raise an attention item with the verdict, the must-read files and an estimated review time. A run that fails still raises one. Answers at once with queued; the report runs in the background, spends money, and only a few run at a time. The other open layers of its stack are prepared with it, and listed as stack. When the user's limit of prepared PRs is reached, it answers backlogged with the PR's place in the backlog; a backlogged PR starts on its own once earlier ones are reviewed or dismissed, so don't call again for it. Answers already-preparing or already-prepared for a PR it has in hand, and needs-go-ahead for a repo the user hasn't registered, which it doesn't start. A large or over-budget PR is checked out but not verified until the user agrees in the workspace. Never runs the repo's setup script. Posts nothing to the PR.",
      inputSchema: z.object({
        owner: githubNameSchema.describe("Repository owner"),
        repo: githubNameSchema.describe("Repository name"),
        number: prNumberSchema.describe("Pull request number"),
      }),
      execute: async ({ owner, repo, number }) => {
        try {
          return await prepReview(
            db,
            config,
            { provider: "github", owner, repo, number },
            deps.prep?.(db) ?? defaultPrepDeps(db, config),
          );
        } catch (e) {
          if (e instanceof ReviewWorkspaceError) return { status: "error", error: e.message };
          console.error("[review-prep] could not prepare a review:", describeError(e));
          return { status: "error", error: clientError(e) };
        }
      },
    }),
  };
}
