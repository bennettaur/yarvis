/**
 * JIRA-side helpers that don't belong on the REST client: the best-effort side
 * effects of starting work on a ticket. The workspace + issue link are the
 * source of truth (persisted by the shared issue service), so each JIRA write
 * here degrades to a warning rather than aborting the start-work flow — the
 * mirror of the GitHub assign+label side effects in `issues/service.ts`.
 */

import type { JiraClient } from "./client.ts";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface JiraStartWorkOptions {
  assignSelf: boolean;
  transitionToInProgress: boolean;
}

/**
 * Assigns the issue to the viewer and transitions it into an in-progress status
 * (the JIRA analogue of GitHub's assign + "in progress" label). Picks the first
 * transition whose destination is in the in-progress category; if none exists
 * (some workflows gate it), that becomes a warning rather than a failure.
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
      const target = transitions.find((t) => t.toStatusCategory === "in_progress");
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
