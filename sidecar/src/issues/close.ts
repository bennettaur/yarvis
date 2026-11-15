import { isAllowedAzureOrgUrl } from "../azure/client.ts";
import { AzureBoardsClient } from "../azureBoards/client.ts";
import { pickCloseState } from "../azureBoards/service.ts";
import type { Config } from "../config.ts";
import type { IssueLink } from "../db/schema.ts";
import { createGitHubClient } from "../github/client.ts";
import { isAllowedJiraBaseUrl, JiraClient } from "../jira/client.ts";
import { pickCloseTransition } from "../jira/service.ts";

/** Closes a linked issue on its tracker. Throws with a reason the user can act on. */
export type IssueCloser = (
  link: Pick<IssueLink, "provider" | "sourceKey" | "externalId">,
) => Promise<void>;

/**
 * Builds a closer from the configured tracker credentials. Each provider is
 * checked at call time, so an unconfigured tracker fails only the issues that
 * belong to it.
 */
export function createIssueCloser(config: Config): IssueCloser {
  return async ({ provider, sourceKey, externalId }) => {
    switch (provider) {
      case "github": {
        const token = config.secrets.githubToken;
        if (!token) throw new Error("GitHub is not configured");
        const [owner, repo, ...rest] = sourceKey.split("/");
        const number = Number(externalId);
        if (!owner || !repo || rest.length > 0 || !Number.isInteger(number) || number < 1) {
          throw new Error(`not a GitHub issue: ${sourceKey}#${externalId}`);
        }
        await createGitHubClient(config, token).updateIssue(owner, repo, number, {
          state: "closed",
        });
        return;
      }
      case "jira": {
        const { jiraBaseUrl, jiraEmail, jiraApiToken } = config.secrets;
        if (!jiraBaseUrl || !jiraEmail || !jiraApiToken) throw new Error("JIRA is not configured");
        // The API token is sent to this host, so it must be Atlassian's.
        if (!isAllowedJiraBaseUrl(jiraBaseUrl)) throw new Error("JIRA base URL is not allowed");
        const jira = new JiraClient(jiraBaseUrl, jiraEmail, jiraApiToken);
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
        const id = Number(externalId);
        if (!Number.isInteger(id) || id < 1) throw new Error(`not a work item id: ${externalId}`);
        const boards = new AzureBoardsClient(azureDevopsToken, azureDevopsOrgUrl);
        const { state, states } = await boards.stateInfo(id);
        if (states.find((s) => s.name === state)?.category === "done") return;
        const target = pickCloseState(states);
        if (!target) throw new Error("no done state available for this work item type");
        await boards.setState(id, target.name);
        return;
      }
      default:
        throw new Error(`unknown issue provider: ${provider}`);
    }
  };
}
