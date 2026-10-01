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
  /** Every state the item's type allows, in workflow order. */
  states: BoardsState[];
}
