import type { Provider, PrRef, PrSummary } from "./types";

/**
 * Which list the PRs tab is showing. "reviewing" is GitHub-only — the panel
 * falls back to "mine" when the active provider doesn't offer it.
 */
const TAB_KEYS = ["mine", "review", "reviewing", "filters"] as const;

export type PrsTabKey = (typeof TAB_KEYS)[number];

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

export function defaultPrsPlace(): PrsPlace {
  return { provider: "github", tab: "mine", selected: null };
}

function isProvider(value: unknown): value is Provider {
  return value === "github" || value === "azure";
}

function isTabKey(value: unknown): value is PrsTabKey {
  return typeof value === "string" && (TAB_KEYS as readonly string[]).includes(value);
}

/**
 * Every field of the discriminated union, not just the provider: `refApiPath`
 * interpolates the PR number into a sidecar path unencoded because the type
 * says it's a number, so a deserializer that doesn't prove that is handing the
 * rest of the app a lie.
 */
function isPrRef(value: unknown): value is PrRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  if (ref.provider === "github") {
    return (
      typeof ref.owner === "string" && typeof ref.repo === "string" && Number.isInteger(ref.number)
    );
  }
  return (
    ref.provider === "azure" &&
    typeof ref.org === "string" &&
    typeof ref.project === "string" &&
    typeof ref.repo === "string" &&
    Number.isInteger(ref.prId)
  );
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Identity plus what the header needs while the refetch is in flight — the
 * detail view reloads everything else from the ref, so the remaining `PrSummary`
 * fields aren't worth gating a restore on.
 */
function isPrSummary(value: unknown): value is PrSummary {
  if (typeof value !== "object" || value === null) return false;
  const { ref, title, url } = value as Record<string, unknown>;
  return isPrRef(ref) && typeof title === "string" && isHttpUrl(url);
}

export function readPrsPlace(): PrsPlace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPrsPlace();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return defaultPrsPlace();
    const { provider, tab, selected } = parsed as Record<string, unknown>;
    const restoredProvider = isProvider(provider) ? provider : "github";
    return {
      provider: restoredProvider,
      tab: isTabKey(tab) ? tab : "mine",
      // A selection belonging to a different provider than the one we're
      // restoring can't be fetched by that provider's client, so drop it rather
      // than open a detail view that can never populate.
      selected:
        isPrSummary(selected) && selected.ref.provider === restoredProvider ? selected : null,
    };
  } catch {
    // Corrupt or unavailable storage: start at the default place; the next
    // write rewrites the slot.
    return defaultPrsPlace();
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
