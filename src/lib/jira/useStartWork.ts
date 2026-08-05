import { useCallback, useState } from "react";
import { requestOpenWorkspace } from "../nav";
import { jiraIssueDetail, jiraStartWork } from "./api";
import type { JiraIssueDetail, StartWorkChoice } from "./types";

export interface JiraStartWorkFlow {
  /** Issue key whose detail is being fetched before the picker can open, or
   *  null when idle. Lets a list mark the one row that is busy. */
  preparingKey: string | null;
  /** The ticket awaiting a repo/status choice; null when the picker is closed. */
  pending: JiraIssueDetail | null;
  starting: boolean;
  error: string | null;
  warnings: string[];
  open: (key: string, known?: JiraIssueDetail) => Promise<void>;
  confirm: (choice: StartWorkChoice) => Promise<void>;
  cancel: () => void;
}

/**
 * The JIRA "Start work" flow, shared by the issue list rows and the detail
 * view. A JIRA ticket isn't tied to a repo, so `open` gathers the detail the
 * repo/status picker needs (transitions, body) and `confirm` runs the start
 * with what the user chose, handing off to the Workspaces tab. `onStarted`
 * fires after the link exists so the caller can refresh its in-progress badges.
 */
export function useJiraStartWork(onStarted?: () => void): JiraStartWorkFlow {
  const [preparingKey, setPreparingKey] = useState<string | null>(null);
  const [pending, setPending] = useState<JiraIssueDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const open = useCallback(async (key: string, known?: JiraIssueDetail) => {
    setError(null);
    setWarnings([]);
    if (known) {
      setPending(known);
      return;
    }
    // A list row carries only a summary, but the picker offers the ticket's
    // transitions and the prompt wants its description — both need detail.
    setPreparingKey(key);
    try {
      setPending(await jiraIssueDetail(key));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparingKey(null);
    }
  }, []);

  const confirm = useCallback(
    async (choice: StartWorkChoice) => {
      if (!pending) return;
      setStarting(true);
      setError(null);
      setWarnings([]);
      try {
        const result = await jiraStartWork({
          sourceKey: pending.sourceKey,
          externalId: pending.externalId,
          title: pending.title,
          body: pending.body,
          url: pending.url,
          repoIds: choice.repoIds,
          transitionToInProgress: choice.transitionToInProgress,
          transitionId: choice.transitionId,
        });
        setWarnings(result.warnings);
        setPending(null);
        onStarted?.();
        requestOpenWorkspace({ id: result.workspaceId, claudePrompt: result.prompt });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setStarting(false);
      }
    },
    [pending, onStarted],
  );

  const cancel = useCallback(() => setPending(null), []);

  return { preparingKey, pending, starting, error, warnings, open, confirm, cancel };
}
