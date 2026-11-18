import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_PR_NUMBER } from "../workspaces/poller.ts";
import { callerError, jsonResult, toolError } from "./results.ts";

/**
 * Lets the agent session in a workspace link a PR it opened to one of the
 * workspace's repos, so the workspace shows that PR's state without waiting
 * for the next search of its branches to find it.
 */

export interface LinkPullRequestInput {
  /** The repo's folder in the workspace, or its name. */
  repo: string;
  number: number;
}

export interface LinkPullRequestResult {
  repo: string;
  number: number;
  url: string | null;
  state: string | null;
}

/** Links a PR to one workspace's repo; a refusal the agent can act on is a {@link PrLinkToolRefusal}. */
export type LinkPullRequest = (
  workspaceId: string,
  input: LinkPullRequestInput,
) => Promise<LinkPullRequestResult>;

/** A link the agent can fix by asking differently: an unknown repo, a missing PR. */
export class PrLinkToolRefusal extends Error {}

const MAX_NAME_LENGTH = 200;

export function registerPrLinkTools(
  server: McpServer,
  workspaceId: string,
  linkPullRequest: LinkPullRequest,
): void {
  server.registerTool(
    "link_pull_request",
    {
      title: "Link a pull request",
      description: [
        "Record the pull request for one of this workspace's repos, so the user sees its state and checks in Yarvis.",
        "Call it after opening a PR from one of this workspace's branches.",
        "A repo can have any number of linked PRs: this adds one and leaves the others.",
        "The PR must exist in that repo, must not come from a fork, and must not be one the user unlinked. A repo takes at most 20 linked PRs. Returns its `url` and `state`.",
      ].join(" "),
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .max(MAX_NAME_LENGTH)
          .describe("The repo's folder in the workspace, or its name"),
        number: z
          .number()
          .int()
          .positive()
          .max(MAX_PR_NUMBER)
          .describe("The pull request's number (or Azure id)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ repo, number }) => {
      try {
        return jsonResult(await linkPullRequest(workspaceId, { repo, number }));
      } catch (e) {
        if (e instanceof PrLinkToolRefusal) return callerError(e.message);
        return toolError("link_pull_request", e);
      }
    },
  );
}
