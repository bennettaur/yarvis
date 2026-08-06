import type { Provider, PrSummary } from "./types";

/**
 * Which list the PRs tab is showing. "reviewing" is GitHub-only — the panel
 * falls back to "mine" when the active provider doesn't offer it.
 */
export type PrsTabKey = "mine" | "review" | "reviewing" | "filters";

const TAB_KEYS: readonly string[] = ["mine", "review", "reviewing", "filters"];

/** Where the user was in the PRs tab: provider, list, and any open PR. */
export interface PrsPlace {
  provider: Provider;
  tab: PrsTabKey;
  /** The PR whose detail view was open, or null if they were on a list. */
  selected: PrSummary | null;
}

/**
 * Persisted because moving to another app tab unmounts `PrsPanel` outright,
 * which would otherwise drop the user back on the GitHub "My PRs" list every
 * time they came back.
 */
const STORAGE_KEY = "yarvis.prs.place";

function defaultPlace(): PrsPlace {
  return { provider: "github", tab: "mine", selected: null };
}

function isProvider(value: unknown): value is Provider {
  return value === "github" || value === "azure";
}

function isTabKey(value: unknown): value is PrsTabKey {
  return typeof value === "string" && TAB_KEYS.includes(value);
}

/**
 * Identity-only check rather than a full schema: the detail view refetches a
 * PR from its ref, so a stored summary just has to be enough to name the PR
 * and render the header while that fetch is in flight.
 */
function isSummary(value: unknown): value is PrSummary {
  if (typeof value !== "object" || value === null) return false;
  const { ref, title, url } = value as { ref?: unknown; title?: unknown; url?: unknown };
  if (typeof title !== "string" || typeof url !== "string") return false;
  if (typeof ref !== "object" || ref === null) return false;
  return isProvider((ref as { provider?: unknown }).provider);
}

export function readPrsPlace(): PrsPlace {
  const place = defaultPlace();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return place;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return place;
    const { provider, tab, selected } = parsed as Partial<PrsPlace>;
    if (isProvider(provider)) place.provider = provider;
    if (isTabKey(tab)) place.tab = tab;
    // A selection belonging to a different provider than the one we're
    // restoring can't be fetched by that provider's client, so drop it rather
    // than open a detail view that can never populate.
    if (isSummary(selected) && selected.ref.provider === place.provider) place.selected = selected;
    return place;
  } catch {
    // Corrupt or unavailable storage: start at the default place; the next
    // write rewrites the slot.
    return defaultPlace();
  }
}

export function writePrsPlace(place: PrsPlace): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(place));
  } catch {
    // Best-effort — a lost write only costs the user their place on the next
    // tab switch, and the in-session state is unaffected.
  }
}
