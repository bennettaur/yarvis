import { tool } from "ai";
import { z } from "zod";
import { orgFromOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { clientError, describeError } from "../llm/errors.ts";
import { type KickoffDeps, kickOffVerification } from "../reviewWorkspaces/kickoff.ts";
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

const PullRequest = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("github"),
    owner: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
      .describe("Repository owner, e.g. bennettaur"),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9._-]+$/)
      .describe("Repository name, e.g. yarvis"),
    number: z.number().int().positive().describe("Pull request number"),
  }),
  z.object({
    provider: z.literal("azure"),
    project: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => !/[/\\]|\.\./.test(s), "invalid name")
      .describe("Azure DevOps project"),
    repo: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => !/[/\\]|\.\./.test(s), "invalid name")
      .describe("Repository name"),
    prId: z.number().int().positive().describe("Pull request id"),
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
        "Start a guided review of a pull request: an agent reads the change and writes the order to review it in, which the user then reads in the PRs tab. Runs in the background, takes a few minutes and costs an LLM run. The attention bell says when it is ready. Refuses when the PR already has a guide unless regenerate is true, since regenerating throws away how far the user got.",
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
        "Start a verification report on a pull request: Claude Code agents read every changed file in a local checkout and report the summary, must-read files, risk and checks for tests, complexity and code quality. The report opens in the PR's review workspace, which is created and checked out if there isn't one. Runs in the background, can take a while and spends money. The attention bell says when it is done. When the result is needs-confirmation, tell the user the size and estimated cost, and call again with confirmed: true only after they agree.",
      inputSchema: z.object({
        pullRequest: PullRequest,
        sections: z
          .array(z.enum(REPORT_SECTIONS))
          .max(REPORT_SECTIONS.length)
          .optional()
          .describe(
            "Which sections to run. Omit for the defaults; 'flow' (a flow diagram) is off unless named.",
          ),
        confirmed: z
          .boolean()
          .optional()
          .describe(
            "The user agreed to the cost of a large or over-budget PR after being told it.",
          ),
      }),
      execute: async ({ pullRequest, sections, confirmed }) => {
        const ref = toRef(config, pullRequest);
        if ("error" in ref) return ref;
        try {
          return await kickOffVerification(db, config, ref, { sections, confirmed }, kickoffDeps());
        } catch (e) {
          if (e instanceof ReviewWorkspaceError) return { status: "error", error: e.message };
          console.error("[verification] could not start a report:", describeError(e));
          return { status: "error", error: clientError(e) };
        }
      },
    }),
  };
}
