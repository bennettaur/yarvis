import { forgetLayout } from "./tabs/tabLayout";

/** The review workspace the Review tab had open, so it reopens there. */
const SELECTED_KEY = "yarvis.review.selected";

export function readSelectedWorkspace(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

export function writeSelectedWorkspace(id: string | null): void {
  try {
    if (id) localStorage.setItem(SELECTED_KEY, id);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    // Non-fatal: the tab just reopens on the list.
  }
}

/**
 * Forgets what this browser kept for a workspace that has been archived: its
 * tabs, and the Review tab's memory of having it open.
 */
export function forgetReviewWorkspace(id: string): void {
  forgetLayout(id);
  if (readSelectedWorkspace() === id) writeSelectedWorkspace(null);
}
