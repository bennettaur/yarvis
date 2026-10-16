/**
 * Outbound HTTP for URLs the sidecar doesn't fully trust: a page the user
 * linked, a document to ingest, a custom speech provider.
 *
 * Three things have to hold on every request, and they are kept in one place
 * because the copies had drifted apart (one's deadline missed the body read,
 * one hard-coded its redirect cap):
 *
 *   - the SSRF guard runs on every redirect hop, not just the first, because
 *     under `redirect: "follow"` a 302 to a private address is followed before
 *     anything can check it, and `fetch` strips only `Authorization` across
 *     origins, so a provider's own auth headers would ride along;
 *   - the connection goes to the address that was checked (`pinnedFetch`), so a
 *     DNS-rebinding host can't pass the check and then resolve somewhere else;
 *   - a body is read with a size cap, so a lying or missing Content-Length
 *     can't fill memory.
 */

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import {
  assertResolvableOutbound,
  createSafeLookup,
  type OutboundUrlOptions,
  type Resolver,
} from "./urlSafety.ts";

export const MAX_REDIRECTS = 5;

/** Statuses whose response must not carry a body, which `Response` enforces. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export interface PinnedFetchOptions extends OutboundUrlOptions {
  /** Replaces DNS for tests. */
  resolve?: Resolver;
}

/**
 * A `fetch` that connects only to addresses the SSRF guard accepted.
 *
 * Bun's `fetch` resolves hosts itself with no hook to check the answer, so this
 * goes through `node:http(s)` instead, whose `lookup` option is the hook. It
 * never follows redirects (callers loop with `guardedFetch`), and it doesn't go
 * through an HTTP proxy from the environment the way Bun's `fetch` does.
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}): typeof fetch {
  const lookup = createSafeLookup(options);
  const pinned = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Building a Request normalizes every body shape fetch accepts, FormData
    // included, into bytes plus the Content-Type it implies.
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const url = new URL(request.url);
    // Read before the body: Bun drops the implied multipart Content-Type from
    // the headers' iterator once a FormData body has been consumed.
    const headers = Object.fromEntries(request.headers);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const client = url.protocol === "https:" ? https : http;
    if (body) headers["content-length"] = String(body.byteLength);

    return new Promise<Response>((resolve, reject) => {
      const req = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
          lookup: lookup as unknown as http.RequestOptions["lookup"],
          signal: init?.signal ?? undefined,
        },
        (res) => resolve(toResponse(res)),
      );
      req.on("error", reject);
      req.end(body);
    });
  };
  return pinned as typeof fetch;
}

/**
 * Wraps a Node response as a web `Response`. Bun's `fetch` decompresses for
 * its callers, so this does too.
 */
function toResponse(res: http.IncomingMessage): Response {
  const status = res.statusCode ?? 502;
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  if (NULL_BODY_STATUSES.has(status)) {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage, headers });
  }
  let source: Readable = res;
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? zlib.createGunzip()
      : encoding === "deflate"
        ? zlib.createInflate()
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : null;
  if (decoder) {
    source = res.pipe(decoder);
    res.on("error", (e) => decoder.destroy(e));
    // The decoded length isn't known, and the encoding no longer applies.
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  const stream = Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, { status, statusText: res.statusMessage, headers });
}

export interface GuardedFetchOptions extends OutboundUrlOptions {
  /** Replaces the pinned transport; tests pass a fake. */
  fetchImpl?: typeof fetch;
  /** Ends the whole request, redirects and body read included, when aborted. */
  signal?: AbortSignal;
}

/**
 * Fetches `url`, following up to `MAX_REDIRECTS` redirects with the SSRF guard
 * on each hop. Returns the final response; its body is not read. A 3xx with no
 * Location is returned as-is for the caller to report.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit,
  { fetchImpl, signal, allowLoopback = false }: GuardedFetchOptions = {},
): Promise<{ response: Response; url: string }> {
  const transport = fetchImpl ?? createPinnedFetch({ allowLoopback });
  const request: RequestInit = { ...init, redirect: "manual", signal };
  let current = (await assertResolvableOutbound(url, { allowLoopback })).toString();
  let response = await transport(current, request);
  let redirects = 0;
  while (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) break;
    redirects += 1;
    if (redirects > MAX_REDIRECTS) throw new TooManyRedirectsError();
    const next = new URL(location, current).toString();
    current = (await assertResolvableOutbound(next, { allowLoopback })).toString();
    response = await transport(current, request);
  }
  return { response, url: current };
}

export class TooManyRedirectsError extends Error {
  constructor() {
    super("too many redirects");
    this.name = "TooManyRedirectsError";
  }
}

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response larger than ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Reads a body, cancelling the stream as soon as it passes `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
