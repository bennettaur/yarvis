/**
 * Frontend Azure Boards shapes, mirroring the sidecar's `azureBoards/types.ts`.
 * List rows reuse the shared `IssueSummary`; the detail view uses
 * `BoardsWorkItemDetail`.
 */

import type { IssueDetail } from "../issues/types";

export type BoardsStateCategory = "todo" | "in_progress" | "done";

export interface BoardsState {
  name: string;
  category: BoardsStateCategory;
}

/** Bugs keep their main text in Repro Steps; every other type uses Description. */
export type BoardsBodyField = "description" | "reproSteps";

export interface BoardsViewer {
  login: string;
  uniqueName: string;
}

export interface BoardsWorkItemDetail extends IssueDetail {
  assignee: string | null;
  statusName: string;
  statusCategory: BoardsStateCategory;
  issueType: string;
  priority: string | null;
  /** Which field `body` was read from, and so which one an edit writes. */
  bodyField: BoardsBodyField;
  /** Every state the item's type allows, in workflow order. */
  states: BoardsState[];
}
