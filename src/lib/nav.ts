import { listen } from "@tauri-apps/api/event";
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
const OPEN_WORKSPACE_EVENT = "yarvis:open-workspace";

interface OpenPrEvent extends Event {
  detail: PrSummary;
}

interface OpenWorkspaceEvent extends Event {
  detail: string;
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

/**
 * Request to switch to the Workspaces tab and select a workspace.
 */
export function requestOpenWorkspace(id: string): void {
  const event = new CustomEvent(OPEN_WORKSPACE_EVENT, { detail: id });
  target.dispatchEvent(event);
}

/**
 * Subscribe to workspace navigation requests.
 */
export function onOpenWorkspace(handler: (id: string) => void): () => void {
  const listener = (e: Event) => handler((e as OpenWorkspaceEvent).detail);
  target.addEventListener(OPEN_WORKSPACE_EVENT, listener);
  return () => target.removeEventListener(OPEN_WORKSPACE_EVENT, listener);
}

/** React-friendly hook for workspace navigation. */
export function useOpenWorkspaceListener(handler: (id: string) => void): void {
  useEffect(() => onOpenWorkspace(handler), [handler]);

  // Also listen for backend-initiated workspace opens (e.g. from the agent).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      const u = await listen<string>("workspace-opened", (event) => {
        handler(event.payload);
      });
      unlisten = u;
    };
    void setup();
    return () => unlisten?.();
  }, [handler]);
}
