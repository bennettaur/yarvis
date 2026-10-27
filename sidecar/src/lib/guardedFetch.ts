import { assertResolvableOutbound, validateOutboundUrl } from "./urlSafety.ts";

/** Redirect hops followed before giving up, matching `memory/ingest.ts`. */
const MAX_REDIRECTS = 5;

export interface GuardedFetchOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  allowLoopback: boolean;
  /**
   * Refuse a redirect to another origin instead of following it. For a request
   * whose body is private, such as a chat transcript, since a redirect replays
   * the body and every custom header to the new host.
   */
  sameOriginOnly?: boolean;
  /**
   * Check each hop's URL without resolving its host, as `validateOutboundUrl`
   * does. For a user-configured provider, whose base URL is held to that
   * static check when saved and when the AI SDK reaches it: resolving here as
   * well would refuse a LAN hostname that every other call to the same
   * provider reaches.
   */
  staticCheckOnly?: boolean;
}

/**
 * Fetches with the SSRF guard applied to every hop, not just the first.
 *
 * `redirect: "manual"` is what makes that possible: under the default
 * `"follow"`, a 302 from the configured host to a private address is followed
 * before anything can re-check it, and `fetch` strips only `Authorization` on a
 * cross-origin redirect — a custom provider's own auth headers would ride
 * along to wherever the redirect pointed. The deadline covers the whole chain,
 * since these calls sit directly in the user's latency path. A caller's own
 * `init.signal` still cancels it, and also covers reading the body.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit,
  {
    fetchImpl,
    timeoutMs,
    allowLoopback,
    sameOriginOnly = false,
    staticCheckOnly = false,
  }: GuardedFetchOptions,
): Promise<Response> {
  const assertAllowed = async (target: string) => {
    if (staticCheckOnly) validateOutboundUrl(target, { allowLoopback });
    else await assertResolvableOutbound(target, { allowLoopback });
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal;
  try {
    await assertAllowed(url);
    let current = url;
    let res = await fetchImpl(current, { ...init, redirect: "manual", signal });
    let hops = 0;
    while (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      if (hops++ >= MAX_REDIRECTS) throw new Error("too many redirects");
      const next = new URL(location, current);
      if (sameOriginOnly && next.origin !== new URL(current).origin) {
        throw new Error(`refused a redirect to another origin (${next.origin})`);
      }
      current = next.toString();
      await assertAllowed(current);
      res = await fetchImpl(current, { ...init, redirect: "manual", signal });
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}
