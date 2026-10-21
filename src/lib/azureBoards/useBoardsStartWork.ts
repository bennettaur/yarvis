import { useCallback, useRef, useState } from "react";
import type { JiraTransition, StartWorkChoice } from "../jira/types";
import { requestOpenWorkspace } from "../nav";
import { boardsItemDetail, boardsStartWork } from "./api";
import type { BoardsWorkItemDetail } from "./types";

export interface BoardsStartWorkFlow {
  /** Work item id whose detail is loading before the picker can open. */
  preparingId: string | null;
  /** The work item awaiting a repo/state choice; null when the picker is closed. */
  pending: BoardsWorkItemDetail | null;
  starting: boolean;
  error: string | null;
  warnings: string[];
  /** Starts from a list row, which carries only a summary. */
  start: (id: string) => Promise<void>;
  /** Starts from the detail view, which already holds the work item. */
  startWithDetail: (detail: BoardsWorkItemDetail) => void;
  confirm: (choice: StartWorkChoice) => Promise<void>;
  cancel: () => void;
}

/**
 * The states a work item can move to, shaped for the shared repo/status picker.
 * Azure sets a state directly rather than through named transitions, so each
 * state other than the current one is offered, keyed by its name.
 */
export function statesAsTransitions(detail: BoardsWorkItemDetail): JiraTransition[] {
  return detail.states
    .filter((s) => s.name !== detail.statusName)
    .map((s) => ({ id: s.name, name: s.name, toStatusName: s.name, toStatusCategory: s.category }));
}

/**
 * The Azure Boards "Start work" flow, shared by the list rows and the detail
 * view. It works like `useJiraStartWork`: load the detail the picker needs,
 * then start with the user's repo and state choice and open the workspace.
 */
export function useBoardsStartWork(onStarted?: () => void): BoardsStartWorkFlow {
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [pending, setPending] = useState<BoardsWorkItemDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // A detail fetch the user has moved on from must not pop the picker open.
  const awaitedId = useRef<string | null>(null);

  const startWithDetail = useCallback((detail: BoardsWorkItemDetail) => {
    setError(null);
    setWarnings([]);
    setPending(detail);
  }, []);

  const start = useCallback(async (id: string) => {
    setError(null);
    setWarnings([]);
    setPreparingId(id);
    awaitedId.current = id;
    try {
      const detail = await boardsItemDetail(id);
      if (awaitedId.current === id) setPending(detail);
    } catch (e) {
      if (awaitedId.current === id) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparingId((current) => (current === id ? null : current));
    }
  }, []);

  const confirm = useCallback(
    async (choice: StartWorkChoice) => {
      if (!pending) return;
      setStarting(true);
      setError(null);
      setWarnings([]);
      try {
        const result = await boardsStartWork({
          sourceKey: pending.sourceKey,
          externalId: pending.externalId,
          title: pending.title,
          body: pending.body,
          url: pending.url,
          repoIds: choice.repoIds,
          moveToInProgress: choice.transitionToInProgress,
          // `statesAsTransitions` keys each option by its state name.
          state: choice.transitionId,
        });
        setWarnings(result.warnings);
        setPending(null);
        onStarted?.();
        requestOpenWorkspace({ id: result.workspaceId });
      } catch (e) {
        // The picker stays open so the choice survives a retry.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setStarting(false);
      }
    },
    [pending, onStarted],
  );

  const cancel = useCallback(() => {
    awaitedId.current = null;
    setPending(null);
    setPreparingId(null);
  }, []);

  return {
    preparingId,
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
