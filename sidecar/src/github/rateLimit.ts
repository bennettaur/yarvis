import { GitHubError } from "./errors.ts";

type FetchFn = typeof fetch;

/**
 * When each token may next call each of GitHub's rate-limit buckets. Module
 * level because a client is built per request, and the limit belongs to the
 * token, not to one client.
 */
const blockedUntil = new Map<string, number>();

/** Used when GitHub signals a limit but gives no time to wait. */
const DEFAULT_BACKOFF_MS = 60_000;

/** GitHub limits search, GraphQL and the rest of REST separately. */
function bucketOf(url: string): string {
  const path = new URL(url).pathname;
  if (path.endsWith("/graphql")) return "graphql";
  if (path.startsWith("/search/")) return "search";
  return "core";
}

/**
 * Wraps `fetchImpl` so a rate-limited token stops calling GitHub until the
 * time GitHub gave (`Retry-After`, else `X-RateLimit-Reset`), instead of every
 * poll and page load spending more requests on refusals.
 */
export function rateLimitedFetch(fetchImpl: FetchFn, token: string): FetchFn {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const key = `${token}\u0000${bucketOf(url)}`;
    const until = blockedUntil.get(key);
    if (until !== undefined) {
      if (Date.now() < until) throw backingOff(until);
      blockedUntil.delete(key);
    }

    const res = await fetchImpl(input, init);
    const wait = rateLimitWaitMs(res);
    if (wait !== null) blockedUntil.set(key, Date.now() + wait);
    return res;
  }) as FetchFn;
}

/** How long GitHub asked us to wait, or null when the response isn't a rate limit. */
function rateLimitWaitMs(res: Response): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.max(reset * 1000 - Date.now(), 0);
    return DEFAULT_BACKOFF_MS;
  }
  return res.status === 429 ? DEFAULT_BACKOFF_MS : null;
}

function backingOff(until: number): GitHubError {
  const seconds = Math.ceil((until - Date.now()) / 1000);
  return new GitHubError(
    429,
    "rate_limited",
    `GitHub's rate limit was hit. Waiting ${seconds} more seconds before calling it again.`,
    "(skipped)",
  );
}

/** Test hook: forget every recorded limit. */
export function resetRateLimits(): void {
  blockedUntil.clear();
}
