import type { PrRef } from "./types";

/**
 * Browser links derived from a PR's own web URL, for pasting somewhere outside
 * the app. Derived rather than assembled from a hostname so GitHub Enterprise
 * and self-hosted Azure DevOps keep working; a URL that doesn't match the shape
 * the provider uses resolves to null, and the caller drops the action rather
 * than copying a guess.
 */

const GITHUB_PR_URL_TAIL = /\/pull\/\d+(?:\/[^?#]*)?(?:[?#].*)?$/;
const AZURE_PR_URL_TAIL = /\/pullrequest\/\d+(?:\/[^?#]*)?(?:[?#].*)?$/;

/** The repo's web URL, i.e. the PR URL with its pull-request suffix removed. */
function repoWebUrl(prUrl: string, provider: PrRef["provider"]): string | null {
  const pattern = provider === "github" ? GITHUB_PR_URL_TAIL : AZURE_PR_URL_TAIL;
  if (!pattern.test(prUrl)) return null;
  return prUrl.replace(pattern, "");
}

/**
 * Percent-encodes a repo-relative path, keeping its separators readable — or
 * null when a segment is `.` or `..`. Git refuses to store those, so one
 * arriving from a provider is hostile: `encodeURIComponent` leaves them intact
 * and the browser resolves them away, landing the reader on a different repo
 * than the link appears to name.
 */
function encodePath(path: string): string | null {
  const segments = path.split("/");
  if (segments.some((s) => s === "." || s === "..")) return null;
  return segments.map(encodeURIComponent).join("/");
}

/**
 * Link to one file of a PR as it stands at `headSha` — the form that survives a
 * later push, and the one a reader pastes into Slack to point at code. Null
 * until the head commit is known, since a link to a moving branch would point
 * somewhere else by the time it is read.
 */
export function prFileUrl(
  prUrl: string,
  provider: PrRef["provider"],
  headSha: string,
  path: string,
): string | null {
  if (!headSha) return null;
  const base = repoWebUrl(prUrl, provider);
  if (!base) return null;
  const encoded = encodePath(path);
  if (encoded === null) return null;
  return provider === "github"
    ? `${base}/blob/${encodeURIComponent(headSha)}/${encoded}`
    : `${base}?path=${encodeURIComponent(`/${path}`)}&version=GC${encodeURIComponent(headSha)}`;
}
