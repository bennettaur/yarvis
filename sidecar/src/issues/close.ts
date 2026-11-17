import { isAllowedAzureOrgUrl } from "../azure/client.ts";
import { AzureBoardsClient } from "../azureBoards/client.ts";
import { pickCloseState } from "../azureBoards/service.ts";
import { workItemId } from "../azureBoards/validation.ts";
import type { Config } from "../config.ts";
import type { IssueLink } from "../db/schema.ts";
import { createGitHubClient } from "../github/client.ts";
import { isAllowedJiraBaseUrl, JiraClient } from "../jira/client.ts";
import { pickCloseTransition } from "../jira/service.ts";
import { issueKey } from "../jira/validation.ts";
import { ownerName, repoName } from "./validation.ts";

/** Closes a linked issue on its tracker. Throws with a reason the user can act on. */
export type IssueCloser = (
  link: Pick<IssueLink, "provider" | "sourceKey" | "externalId">,
) => Promise<void>;

/** How long one close may take, across all its requests, before it fails. A
 *  hung tracker would otherwise hold the archive and the chat turn waiting on it. */
export const ISSUE_CLOSE_TIMEOUT_MS = 30_000;

/** A fetch whose requests are all cancelled once `signal` aborts. */
function fetchUntil(signal: AbortSignal): typeof fetch {
  const timed = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    });
  return Object.assign(timed, { preconnect: fetch.preconnect });
}

/**
 * Builds a closer from the configured tracker credentials. Each provider is
 * checked at call time, so an unconfigured tracker fails only the issues that
 * belong to it.
 */
export function createIssueCloser(config: Config, timeoutMs = ISSUE_CLOSE_TIMEOUT_MS): IssueCloser {
  return async (link) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      await closeOne(config, link, fetchUntil(deadline));
    } catch (e) {
      if (deadline.aborted)
        throw new Error(`the tracker didn't answer within ${timeoutMs / 1000}s`);
      throw e;
    }
  };
}

async function closeOne(
  config: Config,
  { provider, sourceKey, externalId }: Parameters<IssueCloser>[0],
  fetchImpl: typeof fetch,
): Promise<void> {
  switch (provider) {
    case "github": {
      const token = config.secrets.githubToken;
      if (!token) throw new Error("GitHub is not configured");
      // Both parts go into the API path with the token attached.
      const [owner = "", repo = "", ...rest] = sourceKey.split("/");
      const issueNumber = Number(externalId);
      if (
        rest.length > 0 ||
        !ownerName.safeParse(owner).success ||
        !repoName.safeParse(repo).success ||
        !Number.isInteger(issueNumber) ||
        issueNumber < 1
      ) {
        throw new Error(`not a GitHub issue: ${sourceKey}#${externalId}`);
      }
      await createGitHubClient(config, token, fetchImpl).updateIssue(owner, repo, issueNumber, {
        state: "closed",
      });
      return;
    }
    case "jira": {
      const { jiraBaseUrl, jiraEmail, jiraApiToken } = config.secrets;
      if (!jiraBaseUrl || !jiraEmail || !jiraApiToken) throw new Error("JIRA is not configured");
      // The API token is sent to this host, so it must be Atlassian's.
      if (!isAllowedJiraBaseUrl(jiraBaseUrl)) throw new Error("JIRA base URL is not allowed");
      if (!issueKey.safeParse(externalId).success) {
        throw new Error(`not a JIRA issue key: ${externalId}`);
      }
      const jira = new JiraClient(jiraBaseUrl, jiraEmail, jiraApiToken, fetchImpl);
      // Already done: a done-to-done transition would only change its resolution.
      const { statusCategory } = await jira.issueSummaryByKey(externalId);
      if (statusCategory === "done") return;
      const target = pickCloseTransition(await jira.transitions(externalId));
      if (!target) throw new Error("no transition to a done status from the current status");
      await jira.transitionIssue(externalId, target.id);
      return;
    }
    case "azure": {
      const { azureDevopsToken, azureDevopsOrgUrl } = config.secrets;
      if (!azureDevopsToken || !azureDevopsOrgUrl) {
        throw new Error("Azure Boards is not configured");
      }
      // The PAT is sent to this host, so it must be Azure's.
      if (!isAllowedAzureOrgUrl(azureDevopsOrgUrl)) {
        throw new Error("Azure DevOps org URL is not allowed");
      }
      const parsedId = workItemId.safeParse(externalId);
      if (!parsedId.success) throw new Error(`not a work item id: ${externalId}`);
      const boards = new AzureBoardsClient(azureDevopsToken, azureDevopsOrgUrl, fetchImpl);
      const { state, states } = await boards.stateInfo(parsedId.data);
      // Already closed on the board: moving it would only swap one done state for another.
      const currentCategory = states.find((s) => s.name === state)?.category;
      if (currentCategory === "done") return;
      const target = pickCloseState(states);
      if (!target) throw new Error("no done state available for this work item type");
      await boards.setState(parsedId.data, target.name);
      return;
    }
    default:
      throw new Error(`unknown issue provider: ${provider}`);
  }
}
