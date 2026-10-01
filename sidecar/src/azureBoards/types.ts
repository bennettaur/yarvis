/**
 * Azure Boards shapes that extend the provider-neutral issue types with what the
 * work item view edits: the states the item's type allows, and the assignee.
 * List rows reuse the shared `IssueSummary` (with `statusName`/`statusCategory`/
 * `issueType` populated), exactly as JIRA does.
 *
 * A work item is keyed by (provider "azure", sourceKey = project name,
 * externalId = the numeric work item id as a string).
 */

import type { IssueDetail } from "../issues/types.ts";

/**
 * Azure's state categories folded onto the three JIRA uses, so both providers
 * group and colour rows the same way. Azure's "Proposed" is to-do, "InProgress"
 * is in progress, and "Resolved", "Completed" and "Removed" are all done.
 */
export type BoardsStateCategory = "todo" | "in_progress" | "done";

/** One state a work item's type allows, e.g. "Active" in the in-progress category. */
export interface BoardsState {
  name: string;
  category: BoardsStateCategory;
}

/** The authenticated Azure DevOps user. */
export interface BoardsViewer {
  login: string;
  /** What `System.AssignedTo` accepts for this user: their sign-in email when
   *  Azure reports one, else their display name. */
  uniqueName: string;
}

/** Bugs keep their main text in Repro Steps; every other type uses Description. */
export type BoardsBodyField = "description" | "reproSteps";

/** Rich work item detail for the detail view. */
export interface BoardsWorkItemDetail extends IssueDetail {
  assignee: string | null;
  statusName: string;
  statusCategory: BoardsStateCategory;
  issueType: string;
  priority: string | null;
  /** Which field `body` was read from, and so which one an edit writes. */
  bodyField: BoardsBodyField;
  /** Every state the item's type allows, in the order its workflow lists them. */
  states: BoardsState[];
}
