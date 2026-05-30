import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import net from "node:net";

/**
 * Shared SSRF / outbound-URL guard, used by the URL ingest path and by
 * custom-provider `baseUrl` validation. Both flows send authenticated
 * outbound requests from the sidecar (which sits on the user's loopback
 * with the user's network access), so anything that gates the URL is
 * also gating credential exfiltration to attacker-controlled hosts.
 *
 * Two checks are exposed:
 *   - `validateOutboundUrl(url)`        static checks only (scheme, userinfo,
 *                                       literal-IP ranges). Cheap; safe to use
 *                                       at CRUD time when DNS may not be set
 *                                       up yet.
 *   - `assertResolvableOutbound(url)`   the static checks PLUS a DNS lookup
 *                                       that rejects any host whose A/AAAA
 *                                       resolves into private / loopback /
 *                                       link-local space. Must be used
 *                                       immediately before the actual fetch.
 */

export class UrlSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlSafetyError";
  }
}

function isPrivateIPv4(addr: string): boolean {
  // Handles classful private ranges plus loopback, link-local, multicast, and
  // the IETF-reserved 0.0.0.0/8 catch-all.
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // Unique-local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) — apply the v4 check to the trailing dotted quad.
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  // Site-local fec0::/10 — deprecated, still treated as private.
  if (/^fec[0-9a-f]:/.test(lower)) return true;
  return false;
}

function isPrivateAddress(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 4) return isPrivateIPv4(addr);
  if (family === 6) return isPrivateIPv6(addr);
  return false;
}

/**
 * Performs the cheap, synchronous half of the SSRF guard: scheme, userinfo,
 * literal-IP host checks, and a hostname denylist. DNS is *not* resolved —
 * call `assertResolvableOutbound` for that, immediately before the fetch.
 */
export function validateOutboundUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new UrlSafetyError("invalid url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlSafetyError("only http(s) urls are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new UrlSafetyError("urls with embedded credentials are not allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) throw new UrlSafetyError("url must have a host");

  // URL.hostname wraps IPv6 literals in `[…]`; strip the brackets before
  // running the IP-family check so the literal-private detection sees a
  // plain address.
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  // Literal IPs: check directly, ignoring DNS.
  if (net.isIP(bareHost) && isPrivateAddress(bareHost)) {
    throw new UrlSafetyError("refusing to reach a private address");
  }

  // Hostname denylist for the common non-IP forms that resolve to loopback.
  if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") {
    throw new UrlSafetyError("refusing to reach a private address");
  }
  // `.local` is mDNS / link-local discovery — never an intended outbound target.
  if (host.endsWith(".local") || host.endsWith(".localhost")) {
    throw new UrlSafetyError("refusing to reach a private address");
  }

  return parsed;
}

/**
 * Full guard: static checks plus DNS resolution. Use immediately before the
 * actual outbound fetch so a DNS-rebinding host can't slip past a CRUD-time
 * check. Returns the parsed URL on success.
 */
export async function assertResolvableOutbound(input: string): Promise<URL> {
  const parsed = validateOutboundUrl(input);
  const host = parsed.hostname;
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (net.isIP(bareHost)) {
    // Already validated literally above.
    return parsed;
  }

  let records: LookupAddress[];
  try {
    records = await dns.lookup(bareHost, { all: true });
  } catch {
    throw new UrlSafetyError(`dns lookup failed for ${bareHost}`);
  }
  if (records.length === 0) {
    throw new UrlSafetyError(`dns lookup returned no addresses for ${bareHost}`);
  }
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new UrlSafetyError("refusing to reach a private address");
    }
  }
  return parsed;
}
