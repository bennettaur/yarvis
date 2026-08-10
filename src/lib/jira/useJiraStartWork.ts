import { useCallback, useRef, useState } from "react";
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
  /** Starts from a list row, which carries only a summary. */
  start: (key: string) => Promise<void>;
  /** Starts from the detail view, which already holds the ticket. */
  startWithDetail: (detail: JiraIssueDetail) => void;
  confirm: (choice: StartWorkChoice) => Promise<void>;
  cancel: () => void;
}

/**
 * The JIRA "Start work" flow, shared by the issue list rows and the detail
 * view. A JIRA ticket isn't tied to a repo, so starting first gathers what the
 * repo/status picker needs (transitions, body); `confirm` then runs the start
 * with what the user chose and hands off to the Workspaces tab. `onStarted`
 * fires after the link exists so the caller can refresh its in-progress badges.
 */
export function useJiraStartWork(onStarted?: () => void): JiraStartWorkFlow {
  const [preparingKey, setPreparingKey] = useState<string | null>(null);
  const [pending, setPending] = useState<JiraIssueDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // The ticket the in-flight detail fetch belongs to. A fetch the user has
  // moved on from (cancelled, or superseded by another row) must not pop the
  // picker open when it finally lands.
  const awaitedKey = useRef<string | null>(null);

  const startWithDetail = useCallback((detail: JiraIssueDetail) => {
    setError(null);
    setWarnings([]);
    setPending(detail);
  }, []);

  const start = useCallback(async (key: string) => {
    setError(null);
    setWarnings([]);
    // A list row carries only a summary, but the picker offers the ticket's
    // transitions and the prompt wants its description — both need detail.
    setPreparingKey(key);
    awaitedKey.current = key;
    try {
      const detail = await jiraIssueDetail(key);
      if (awaitedKey.current === key) setPending(detail);
    } catch (e) {
      if (awaitedKey.current === key) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparingKey((current) => (current === key ? null : current));
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
        requestOpenWorkspace({ id: result.workspaceId });
      } catch (e) {
        // The picker stays open on failure so the repo/status choice survives a
        // retry; it renders this error itself, since it covers the view behind.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setStarting(false);
      }
    },
    [pending, onStarted],
  );

  const cancel = useCallback(() => {
    awaitedKey.current = null;
    setPending(null);
    setPreparingKey(null);
  }, []);

  return {
    preparingKey,
    pending,
    starting,
    error,
    warnings,
    start,
    startWithDetail,
    confirm,
    cancel,
  };
}
