import { createHash } from "node:crypto";
import { GitHubError, rateLimitWaitMs } from "./errors.ts";

type FetchFn = typeof fetch;

/**
 * When each token may next call each of GitHub's rate-limit buckets. Module
 * level because a client is built per request, and the limit belongs to the
 * token, not to one client. Keyed by a hash so the token itself isn't kept.
 */
const blockedUntil = new Map<string, number>();

/** GitHub limits search, GraphQL and the rest of REST separately. */
function bucketOf(url: URL): string {
  if (url.pathname.endsWith("/graphql")) return "graphql";
  if (url.pathname.includes("/search/")) return "search";
  return "core";
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Wraps `fetchImpl` so a rate-limited token stops calling GitHub until the
 * time GitHub gave (`Retry-After`, else `X-RateLimit-Reset`), instead of every
 * poll and page load spending more requests on refusals.
 */
export function rateLimitedFetch(fetchImpl: FetchFn, token: string): FetchFn {
  const tokenId = tokenKey(token);
  // Cast because Bun's `typeof fetch` also carries `preconnect`, which callers
  // of this wrapper never use.
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${tokenId}:${bucketOf(url)}`;
    const until = blockedUntil.get(key);
    if (until !== undefined) {
      if (Date.now() < until) throw rateLimitBackoffError(until, url.pathname);
      blockedUntil.delete(key);
    }

    const res = await fetchImpl(input, init);
    // A secondary limit can be named only in the body, so a 403 reads a copy
    // of it; the caller still gets the untouched response.
    const message = res.status === 403 ? await res.clone().text() : null;
    const wait = rateLimitWaitMs(res.status, res.headers, message);
    if (wait !== null) blockedUntil.set(key, Date.now() + wait);
    return res;
  }) as FetchFn;
}

function rateLimitBackoffError(until: number, path: string): GitHubError {
  const seconds = Math.ceil((until - Date.now()) / 1000);
  return new GitHubError(
    429,
    "rate_limited",
    `GitHub's rate limit was hit. Waiting ${seconds} more seconds before calling it again.`,
    path,
  );
}

/** Test hook: forget every recorded limit. */
export function resetRateLimits(): void {
  blockedUntil.clear();
}
