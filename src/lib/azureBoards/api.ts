import { ensureOk, sidecarFetch } from "../api";
import type { IssueComment, IssueSummary, StartWorkResult } from "../issues/types";
import type { BoardsViewer, BoardsWorkItemDetail } from "./types";

/**
 * Frontend client for the Azure Boards routes (`/api/azure-boards`). Work items
 * are addressed by their numeric id, which is unique across the organization.
 */

async function get<T>(path: string): Promise<T> {
  const res = await sidecarFetch(path);
  await ensureOk(res, path);
  return res.json();
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  await ensureOk(res, path);
  return res.json();
}

const itemPath = (id: string) => `/api/azure-boards/item/${encodeURIComponent(id)}`;

/** The authenticated user — also the "is Azure Boards configured and working" probe. */
export const boardsViewer = () => get<BoardsViewer>("/api/azure-boards/viewer");

export const boardsAssigned = () => get<IssueSummary[]>("/api/azure-boards/assigned");

export const boardsCreated = () => get<IssueSummary[]>("/api/azure-boards/created");

/** A query starting with SELECT runs as WIQL; anything else searches open items by title. */
export const boardsSearch = (query: string) =>
  get<IssueSummary[]>(
    /^\s*select\b/i.test(query)
      ? `/api/azure-boards/search?wiql=${encodeURIComponent(query)}`
      : `/api/azure-boards/search?text=${encodeURIComponent(query)}`,
  );

export const boardsItems = (ids: string[]) =>
  get<IssueSummary[]>(`/api/azure-boards/items?ids=${ids.map(encodeURIComponent).join(",")}`);

export const boardsItemDetail = (id: string) => get<BoardsWorkItemDetail>(itemPath(id));

// --- Edits (each returns the refreshed detail) ---

export const boardsUpdateFields = (
  id: string,
  fields: { title?: string; description?: string; reproSteps?: string; tags?: string[] },
) => send<BoardsWorkItemDetail>(itemPath(id), "PATCH", fields);

export const boardsSetState = (id: string, state: string) =>
  send<BoardsWorkItemDetail>(`${itemPath(id)}/state`, "POST", { state });

/** Assigns the item to the current user, or unassigns it. */
export const boardsAssign = (id: string, self: boolean) =>
  send<BoardsWorkItemDetail>(`${itemPath(id)}/assignee`, "PUT", { self });

export const boardsAddComment = (id: string, body: string) =>
  send<IssueComment>(`${itemPath(id)}/comment`, "POST", { body });

// --- Start work ---

export interface BoardsStartWorkInput {
  sourceKey: string;
  externalId: string;
  title: string;
  body: string;
  url?: string | null;
  repoIds: string[];
  assignSelf?: boolean;
  moveToInProgress?: boolean;
  /** A state picked in the dialog; the sidecar picks an in-progress one otherwise. */
  state?: string;
}

export const boardsStartWork = (input: BoardsStartWorkInput) =>
  send<StartWorkResult>("/api/azure-boards/start-work", "POST", input);
