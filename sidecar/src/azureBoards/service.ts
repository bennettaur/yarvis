/**
 * The best-effort side effects of starting work on an Azure Boards work item:
 * assign it to the viewer and move it to a started state. The workspace and
 * issue link are the source of truth, so each write here degrades to a warning
 * rather than aborting, the same as `jira/service.ts`.
 */

import type { AzureBoardsClient } from "./client.ts";
import type { BoardsState } from "./types.ts";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface BoardsStartWorkOptions {
  assignSelf: boolean;
  moveToInProgress: boolean;
  /** A state the user picked in the Start Work dialog, overriding the default. */
  state?: string;
}

/**
 * Chooses the state to move to when starting work. An explicit `requested`
 * state wins when the type allows it. Otherwise the best in-progress match:
 * "In Progress", then "Active" (the Agile and CMMI name), then any
 * in-progress-category state.
 */
export function pickStartWorkState(states: BoardsState[], requested?: string): BoardsState | null {
  if (requested) return states.find((s) => s.name === requested) ?? null;
  const inProgress = states.filter((s) => s.category === "in_progress");
  return (
    inProgress.find((s) => /^in[\s-]?progress$/i.test(s.name.trim())) ??
    inProgress.find((s) => /^active$/i.test(s.name.trim())) ??
    inProgress[0] ??
    null
  );
}

export async function applyBoardsStartWorkSideEffects(
  boards: AzureBoardsClient,
  id: number,
  opts: BoardsStartWorkOptions,
): Promise<string[]> {
  const warnings: string[] = [];
  if (opts.assignSelf) {
    try {
      const me = await boards.viewer();
      await boards.assign(id, me.uniqueName);
    } catch (e) {
      warnings.push(`could not assign work item: ${msg(e)}`);
    }
  }
  if (opts.moveToInProgress) {
    try {
      const { state, states } = await boards.stateInfo(id);
      const target = pickStartWorkState(states, opts.state);
      if (!target) {
        warnings.push(
          opts.state
            ? `"${opts.state}" is not a state this work item type allows`
            : "no in-progress state available for this work item type",
        );
      } else if (target.name !== state) {
        await boards.setState(id, target.name);
      }
    } catch (e) {
      warnings.push(`could not change state: ${msg(e)}`);
    }
  }
  return warnings;
}
