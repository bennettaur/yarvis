import { useCallback, useState } from "react";
import { requestOpenWorkspace } from "../nav";
import { issueDetail, startWork } from "./api";
import { type IssueSummary, issueKey } from "./types";

export interface GithubStartWorkFlow {
  /** Key of the issue currently starting, or null when idle. Lets a list mark
   *  the one row that is busy while the others stay clickable. */
  startingKey: string | null;
  error: string | null;
  warnings: string[];
  start: (issue: IssueSummary, known?: { title?: string; body?: string }) => Promise<void>;
}

/**
 * The GitHub "Start work" flow, shared by the issue list rows and the detail
 * view: create the workspace, link the issue, then hand off to the Workspaces
 * tab, which provisions the worktree and launches a Claude session seeded with
 * the issue prompt. `onStarted` fires after the link exists so the caller can
 * refresh its in-progress badges.
 */
export function useGithubStartWork(onStarted?: () => void): GithubStartWorkFlow {
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const start = useCallback(
    async (issue: IssueSummary, known?: { title?: string; body?: string }) => {
      const key = issueKey(issue.provider, issue.sourceKey, issue.externalId);
      setStartingKey(key);
      setError(null);
      setWarnings([]);
      try {
        // The prompt handed to Claude wants the issue body, which a list row
        // doesn't carry — fetch detail unless the caller already has it.
        const body =
          known?.body ??
          (await issueDetail(issue.sourceKey, issue.externalId, issue.provider)).body;
        const result = await startWork(
          {
            sourceKey: issue.sourceKey,
            externalId: issue.externalId,
            title: known?.title ?? issue.title,
            body,
            url: issue.url,
          },
          issue.provider,
        );
        setWarnings(result.warnings);
        onStarted?.();
        requestOpenWorkspace({ id: result.workspaceId, claudePrompt: result.prompt });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        // Other rows stay clickable while one starts, so only clear the busy
        // marker if a later start hasn't already claimed it.
        setStartingKey((current) => (current === key ? null : current));
      }
    },
    [onStarted],
  );

  return { startingKey, error, warnings, start };
}
