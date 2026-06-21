import type { PrRef } from "./types";

const enc = encodeURIComponent;

/** Stable identity string for cache keys and equality checks. */
export function refKey(ref: PrRef): string {
  return ref.provider === "github"
    ? `gh:${ref.owner}/${ref.repo}/${ref.number}`
    : `az:${ref.org}/${ref.project}/${ref.repo}/${ref.prId}`;
}

/** A DOM-id-safe variant of {@link refKey} (no slashes or colons). */
export function refDomKey(ref: PrRef): string {
  return refKey(ref).replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** The "owner/repo" (GitHub) or "project/repo" (Azure) label shown in lists. */
export function refDisplayRepo(ref: PrRef): string {
  return ref.provider === "github" ? `${ref.owner}/${ref.repo}` : `${ref.project}/${ref.repo}`;
}

/** The PR's user-facing number. */
export function refNumber(ref: PrRef): number {
  return ref.provider === "github" ? ref.number : ref.prId;
}

/**
 * Sidecar base path for one PR. Azure omits the org because the sidecar binds
 * it from configuration; GitHub encodes owner/repo because they can originate
 * from agent-composed Omni layouts.
 */
export function refApiPath(ref: PrRef): string {
  return ref.provider === "github"
    ? `/api/github/pr/${enc(ref.owner)}/${enc(ref.repo)}/${ref.number}`
    : `/api/azure/pr/${enc(ref.project)}/${enc(ref.repo)}/${ref.prId}`;
}

/** The provider label shown on the "open externally" action. */
export function refProviderName(ref: PrRef): string {
  return ref.provider === "github" ? "GitHub" : "Azure DevOps";
}
