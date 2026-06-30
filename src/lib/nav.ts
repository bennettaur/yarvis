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
