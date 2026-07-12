import type { LookupAddress } from "node:dns";
import dns from "node:dns/promises";
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

/**
 * Extracts the embedded IPv4 from an IPv4-mapped IPv6 address (::ffff:0:0/96),
 * returning it as a dotted quad — or null if `addr` is not IPv4-mapped. Two
 * spellings must be handled: the human dotted form `::ffff:1.2.3.4`, and the
 * hex form `::ffff:xxxx:xxxx` that Node's `URL` parser normalizes literals to
 * (e.g. `[::ffff:169.254.169.254]` → `::ffff:a9fe:a9fe`). Missing the hex form
 * would let a mapped literal skip every IPv4 range check.
 */
function mappedIPv4(addr: string): string | null {
  const lower = addr.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1]!;
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // Unique-local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) — apply the v4 check to the embedded address.
  const mapped = mappedIPv4(lower);
  if (mapped) return isPrivateIPv4(mapped);
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
 * Loopback is the narrow subset of private space that lives on the caller's own
 * machine: 127.0.0.0/8 and IPv6 ::1 (including IPv4-mapped loopback). Callers
 * that opt into `allowLoopback` — user-configured local providers such as a
 * local Ollama server — carve this out while every other private range stays
 * blocked.
 */
function isLoopbackAddress(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 4) return addr.split(".")[0] === "127";
  if (family === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1") return true;
    const mapped = mappedIPv4(lower);
    if (mapped) return mapped.split(".")[0] === "127";
  }
  return false;
}

export interface OutboundUrlOptions {
  /**
   * Permit loopback destinations (127.0.0.0/8, ::1, localhost, *.localhost).
   * Set only for user-configured local providers (e.g. a local Ollama server),
   * which legitimately live on loopback. Other private/LAN ranges stay blocked.
   */
  allowLoopback?: boolean;
}

/**
 * Performs the cheap, synchronous half of the SSRF guard: scheme, userinfo,
 * literal-IP host checks, and a hostname denylist. DNS is *not* resolved —
 * call `assertResolvableOutbound` for that, immediately before the fetch.
 */
export function validateOutboundUrl(input: string, options: OutboundUrlOptions = {}): URL {
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

  const allowLoopback = options.allowLoopback === true;

  // Literal IPs: check directly, ignoring DNS. Loopback literals pass when the
  // caller opted in; every other private range is still refused.
  if (net.isIP(bareHost) && isPrivateAddress(bareHost)) {
    if (!(allowLoopback && isLoopbackAddress(bareHost))) {
      throw new UrlSafetyError("refusing to reach a private address");
    }
  }

  // Hostname denylist for the common non-IP forms that resolve to loopback.
  const loopbackHost =
    host === "localhost" ||
    host === "ip6-localhost" ||
    host === "ip6-loopback" ||
    // `.localhost` is guaranteed to resolve to loopback (RFC 6761).
    host.endsWith(".localhost");
  if (loopbackHost && !allowLoopback) {
    throw new UrlSafetyError("refusing to reach a private address");
  }
  // `.local` is mDNS / link-local discovery — another machine, not loopback —
  // so it stays blocked even when loopback is allowed.
  if (host.endsWith(".local")) {
    throw new UrlSafetyError("refusing to reach a private address");
  }

  return parsed;
}

/**
 * Full guard: static checks plus DNS resolution. Use immediately before the
 * actual outbound fetch so a DNS-rebinding host can't slip past a CRUD-time
 * check. Returns the parsed URL on success.
 */
export async function assertResolvableOutbound(
  input: string,
  options: OutboundUrlOptions = {},
): Promise<URL> {
  const parsed = validateOutboundUrl(input, options);
  const host = parsed.hostname;
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const allowLoopback = options.allowLoopback === true;

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
    if (isPrivateAddress(r.address) && !(allowLoopback && isLoopbackAddress(r.address))) {
      throw new UrlSafetyError("refusing to reach a private address");
    }
  }
  return parsed;
}
