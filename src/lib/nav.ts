import { useEffect } from "react";
import type { PrSummary } from "./pr/types";

/**
 * In-app cross-tab navigation requests. Used when a view (e.g. the workspace
 * checks panel) wants to hand the user over to another tab (the PRs tab) with
 * a specific selection. Implemented as a tiny window-EventTarget pub/sub so
 * any component can request it without threading callbacks through the tree.
 */
const target = new EventTarget();

const OPEN_PR_EVENT = "yarvis:open-pr";

interface OpenPrEvent extends Event {
  detail: PrSummary;
}

export function requestOpenPr(pr: PrSummary): void {
  const event = new CustomEvent(OPEN_PR_EVENT, { detail: pr });
  target.dispatchEvent(event);
}

/**
 * Subscribe to "open PR" requests. The handler should switch to the PRs tab
 * and select the requested PR. Returns the cleanup function.
 */
export function onOpenPr(handler: (pr: PrSummary) => void): () => void {
  const listener = (e: Event) => handler((e as OpenPrEvent).detail);
  target.addEventListener(OPEN_PR_EVENT, listener);
  return () => target.removeEventListener(OPEN_PR_EVENT, listener);
}

/** React-friendly hook over `onOpenPr` for the App shell. */
export function useOpenPrListener(handler: (pr: PrSummary) => void): void {
  useEffect(() => onOpenPr(handler), [handler]);
}

const OPEN_WORKSPACE_EVENT = "yarvis:open-workspace";

/**
 * A request to open a workspace on the Workspaces tab. `claudePrompt`, when
 * set (the "Start work on issue" flow), tells the workspace detail view to
 * provision and launch a Claude session seeded with that prompt.
 * `focusSessionKey` (an attention item naming the tab that raised it) asks the
 * workspace's terminal surface to bring that session into view.
 */
export interface OpenWorkspaceRequest {
  id: string;
  claudePrompt?: string;
  focusSessionKey?: string;
}

interface OpenWorkspaceEvent extends Event {
  detail: OpenWorkspaceRequest;
}

export function requestOpenWorkspace(request: OpenWorkspaceRequest): void {
  target.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_EVENT, { detail: request }));
}

/**
 * Subscribe to "open workspace" requests. The handler should switch to the
 * Workspaces tab and select the requested workspace. Returns the cleanup fn.
 */
export function onOpenWorkspace(handler: (request: OpenWorkspaceRequest) => void): () => void {
  const listener = (e: Event) => handler((e as OpenWorkspaceEvent).detail);
  target.addEventListener(OPEN_WORKSPACE_EVENT, listener);
  return () => target.removeEventListener(OPEN_WORKSPACE_EVENT, listener);
}

/** React-friendly hook over `onOpenWorkspace` for the App shell. */
export function useOpenWorkspaceListener(handler: (request: OpenWorkspaceRequest) => void): void {
  useEffect(() => onOpenWorkspace(handler), [handler]);
}

const NEW_WORKSPACE_EVENT = "yarvis:new-workspace";

/**
 * A request to open the New Workspace form on the Workspaces tab, pre-filled
 * from another view. `taskId` links the new workspace to an existing task on
 * create. `claudePrompt`, when set, launches a Claude session seeded with that
 * prompt once the workspace is provisioned (the task "Start work" flow).
 */
export interface NewWorkspaceRequest {
  name?: string;
  taskId?: string;
  claudePrompt?: string;
}

interface NewWorkspaceEvent extends Event {
  detail: NewWorkspaceRequest;
}

export function requestNewWorkspace(request: NewWorkspaceRequest): void {
  target.dispatchEvent(new CustomEvent(NEW_WORKSPACE_EVENT, { detail: request }));
}

export function onNewWorkspace(handler: (request: NewWorkspaceRequest) => void): () => void {
  const listener = (e: Event) => handler((e as NewWorkspaceEvent).detail);
  target.addEventListener(NEW_WORKSPACE_EVENT, listener);
  return () => target.removeEventListener(NEW_WORKSPACE_EVENT, listener);
}

/** React-friendly hook over `onNewWorkspace` for the App shell. */
export function useNewWorkspaceListener(handler: (request: NewWorkspaceRequest) => void): void {
  useEffect(() => onNewWorkspace(handler), [handler]);
}
