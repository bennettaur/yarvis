import { tool } from "ai";
import { z } from "zod";
import { orgFromOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { clientError, describeError } from "../llm/errors.ts";
import { type KickoffDeps, kickOffVerification } from "../reviewWorkspaces/kickoff.ts";
import { githubNameSchema, prNumberSchema, refSegmentSchema } from "../reviewWorkspaces/routes.ts";
import { defaultReviewDeps, ReviewWorkspaceError } from "../reviewWorkspaces/service.ts";
import { defaultVerificationDeps, REPORT_SECTIONS } from "../reviewWorkspaces/verification.ts";
import { kickOffGuide } from "./guideRun.ts";
import type { PrRef } from "./types.ts";

/**
 * Tools that start the review agents the PRs tab and review workspaces run, so
 * the user can ask for one from chat, voice or Telegram. Both run in the
 * background and report through the attention bell. Nothing is posted to the
 * PR: the guide and the report stay on this machine.
 */

/** No Azure `org` field: {@link toRef} takes it from config, so the model can't name another organization. */
const PullRequest = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("github"),
    owner: githubNameSchema.describe("Repository owner, e.g. bennettaur"),
    repo: githubNameSchema.describe("Repository name, e.g. yarvis"),
    number: prNumberSchema.describe("Pull request number"),
  }),
  z.object({
    provider: z.literal("azure"),
    project: refSegmentSchema.describe("Azure DevOps project"),
    repo: refSegmentSchema.describe("Repository name"),
    prId: prNumberSchema.describe("Pull request id"),
  }),
]);
type PullRequest = z.infer<typeof PullRequest>;

/** Azure refs carry the organization, which only the configured org URL may supply. */
function toRef(config: Config, pr: PullRequest): PrRef | { error: string } {
  if (pr.provider === "github") return pr;
  const orgUrl = config.secrets?.azureDevopsOrgUrl;
  if (!orgUrl) return { error: "Azure DevOps isn't configured in Settings → Credentials." };
  return { ...pr, org: orgFromOrgUrl(orgUrl) };
}

export interface PrReviewStartDeps {
  /** Replaces the review and verification dependencies, for tests. */
  kickoff?: (db: Db) => KickoffDeps;
}

export function buildPrReviewStartTools(db: Db, config: Config, deps: PrReviewStartDeps = {}) {
  const kickoffDeps = (): KickoffDeps =>
    deps.kickoff?.(db) ?? {
      review: defaultReviewDeps(db, config),
      verification: defaultVerificationDeps(config),
    };

  return {
    start_pr_guided_review: tool({
      description:
        "Start a guided review of a pull request: an agent reads the change and writes the order to review it in, which the user then reads in the PRs tab. Runs in the background, takes a few minutes and costs an LLM run. The attention bell says when it is ready. Posts nothing to the PR. Answers exists, with how far the user got and whether the PR has moved on since (stale), when the PR already has a guide; regenerate replaces it and throws that progress away.",
      inputSchema: z.object({
        pullRequest: PullRequest,
        regenerate: z
          .boolean()
          .optional()
          .describe("Replace the PR's existing guide. Only when the user asked for a new one."),
      }),
      execute: async ({ pullRequest, regenerate }) => {
        const ref = toRef(config, pullRequest);
        if ("error" in ref) return ref;
        try {
          return await kickOffGuide(db, config, ref, { regenerate });
        } catch (e) {
          console.error("[pr] could not start a guided review:", describeError(e));
          return { status: "error", error: clientError(e) };
        }
      },
    }),

    start_pr_verification_report: tool({
      description:
        "Start a verification report on a pull request: Claude Code agents read every changed file in a local checkout and report the summary, must-read files, risk and checks for tests, complexity and code quality. The report opens in the PR's review workspace, which is created and checked out if there isn't one. Runs in the background, can take a while and spends money. The attention bell says when it is done. Posts nothing to the PR. Answers exists when a report for the PR's current commit is already there. Answers needs-confirmation with a reason: large or over-budget (give the user the size and estimated cost against their budget), unsized (the cost couldn't be estimated), or unregistered-repo (the repo isn't one the user registered; name it). Call again with confirmed: true only after the user agrees.",
      inputSchema: z.object({
        pullRequest: PullRequest,
        sections: z
          .array(z.enum(REPORT_SECTIONS))
          .max(REPORT_SECTIONS.length)
          .optional()
          .describe("Which sections to run. Omit for the defaults."),
        confirmed: z
          .boolean()
          .optional()
          .describe(
            "The user agreed to what a needs-confirmation answer asked, after being told it.",
          ),
        rerun: z
          .boolean()
          .optional()
          .describe(
            "Run again although a report for the current commit exists. Only when the user asked.",
          ),
      }),
      execute: async ({ pullRequest, sections, confirmed, rerun }) => {
        const ref = toRef(config, pullRequest);
        if ("error" in ref) return ref;
        try {
          return await kickOffVerification(
            db,
            config,
            ref,
            { sections, confirmed, rerun },
            kickoffDeps(),
          );
        } catch (e) {
          if (e instanceof ReviewWorkspaceError) return { status: "error", error: e.message };
          console.error("[verification] could not start a report:", describeError(e));
          return { status: "error", error: clientError(e) };
        }
      },
    }),
  };
}
