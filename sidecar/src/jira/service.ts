/**
 * JIRA-side helpers that don't belong on the REST client: the best-effort side
 * effects of starting work on a ticket. The workspace + issue link are the
 * source of truth (persisted by the shared issue service), so each JIRA write
 * here degrades to a warning rather than aborting the start-work flow — the
 * mirror of the GitHub assign+label side effects in `issues/service.ts`.
 */

import type { JiraClient } from "./client.ts";
import type { JiraTransition } from "./types.ts";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface JiraStartWorkOptions {
  assignSelf: boolean;
  transitionToInProgress: boolean;
  /**
   * An explicit transition id to apply, overriding the in-progress heuristic —
   * set when the user picks the target status in the Start Work dialog, since
   * which status means "started" varies per JIRA workflow.
   */
  transitionId?: string;
}

/**
 * Chooses the transition to apply when starting work. An explicit `transitionId`
 * wins (the user picked it). Otherwise the best in-progress match: the
 * in-progress *category* also covers statuses like "Blocked", so a status
 * literally named "In Progress" is preferred, then any status whose name
 * contains "progress", then the first in-progress-category transition.
 */
export function pickStartWorkTransition(
  transitions: JiraTransition[],
  transitionId?: string,
): JiraTransition | null {
  if (transitionId) return transitions.find((t) => t.id === transitionId) ?? null;
  const inProgress = transitions.filter((t) => t.toStatusCategory === "in_progress");
  return (
    inProgress.find((t) => /^in[\s-]?progress$/i.test(t.toStatusName.trim())) ??
    inProgress.find((t) => /progress/i.test(t.toStatusName)) ??
    inProgress[0] ??
    null
  );
}

/**
 * Assigns the issue to the viewer and transitions it to a started status (the
 * JIRA analogue of GitHub's assign + "in progress" label). The target status is
 * `opts.transitionId` when the caller chose one, else the best in-progress
 * match; if neither resolves (some workflows gate it), that becomes a warning
 * rather than a failure.
 */
export async function applyJiraStartWorkSideEffects(
  jira: JiraClient,
  key: string,
  opts: JiraStartWorkOptions,
): Promise<string[]> {
  const warnings: string[] = [];
  if (opts.assignSelf) {
    try {
      const me = await jira.myself();
      await jira.assign(key, me.accountId);
    } catch (e) {
      warnings.push(`could not assign issue: ${msg(e)}`);
    }
  }
  if (opts.transitionToInProgress) {
    try {
      const transitions = await jira.transitions(key);
      const target = pickStartWorkTransition(transitions, opts.transitionId);
      if (target) {
        await jira.transitionIssue(key, target.id);
      } else {
        warnings.push("no in-progress transition available from the current status");
      }
    } catch (e) {
      warnings.push(`could not transition issue: ${msg(e)}`);
    }
  }
  return warnings;
}
