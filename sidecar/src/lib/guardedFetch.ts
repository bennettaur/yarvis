/**
 * Outbound HTTP for URLs the sidecar doesn't fully trust: a page the user
 * linked, a document to ingest, a custom speech provider.
 *
 * Three things have to hold on every request, so they live in one place:
 *
 *   - the SSRF guard runs on every redirect hop, not just the first, because
 *     under `redirect: "follow"` a 302 to a private address is followed before
 *     anything can check it;
 *   - a redirect to another origin carries none of the caller's headers but a
 *     few harmless ones, and no body: `fetch` strips only `Authorization`, so a
 *     provider's own auth header, or the user's recorded audio, would otherwise
 *     go to whichever site the redirect named;
 *   - a server's answer can't crash the process, and a body nobody reads still
 *     releases its connection;
 *   - the connection goes to the address that was checked (`pinnedFetch`), so a
 *     DNS-rebinding host can't pass the check and then resolve somewhere else;
 *   - a body is read with a size cap, so a lying or missing Content-Length
 *     can't fill memory.
 */

import http from "node:http";
import https from "node:https";
import { pipeline, Readable, Transform } from "node:stream";
import zlib from "node:zlib";
import {
  assertResolvableOutbound,
  createSafeLookup,
  type OutboundUrlOptions,
  type Resolver,
  validateOutboundUrl,
} from "./urlSafety.ts";

export const MAX_REDIRECTS = 5;

/**
 * The content encodings decoded for callers, as `fetch` does. A Map, not an
 * object literal: the encoding is the server's text, and `constructor` or
 * `__proto__` must not find something on a prototype.
 */
const DECODERS = new Map<string, () => Transform>([
  ["gzip", zlib.createGunzip],
  ["x-gzip", zlib.createGunzip],
  ["deflate", zlib.createInflate],
  ["br", zlib.createBrotliDecompress],
]);

/** Request headers that say nothing about who is asking, so they may follow a redirect anywhere. */
const PORTABLE_HEADERS = new Set(["accept", "accept-language", "user-agent"]);

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
 * goes through `node:http(s)` instead, whose `lookup` option is the hook. A
 * literal IP never reaches a lookup, so it gets the static check here. It never
 * follows redirects (callers loop with `guardedFetch`), and it doesn't go
 * through an HTTP proxy from the environment the way Bun's `fetch` does. A
 * request body is buffered in full before it is sent.
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}): typeof fetch {
  const lookup = createSafeLookup(options);
  const pinned = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Building a Request normalizes every body shape fetch accepts, FormData
    // included, into bytes plus the Content-Type it implies.
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const url = validateOutboundUrl(request.url, options);
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
          // A fresh connection every time. A pooled socket was opened under
          // whichever lookup ran first, so reusing one could skip this check.
          agent: false,
          signal: request.signal,
        },
        // This callback runs outside the promise's protection, so anything the
        // server's answer makes it throw would otherwise crash the process.
        (res) => {
          try {
            resolve(toResponse(res, request.method));
          } catch (e) {
            res.destroy();
            reject(e);
          }
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  };
  return pinned as typeof fetch;
}

/** Wraps a Node response as a web `Response`, decoding the body as `fetch` would. */
function toResponse(res: http.IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 0;
  // Node's parser accepts any three digits; `Response` throws outside these.
  if (status !== 101 && (status < 200 || status > 599)) {
    throw new Error(`the server answered with an invalid status (${status})`);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  if (NULL_BODY_STATUSES.has(status) || method === "HEAD") {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage, headers });
  }
  // `pipeline`, not `pipe`: an early close, an error or a cancel on any stage
  // has to tear down all of them, or a read can wait past every deadline.
  const stages: Transform[] = [];
  const declaredLength = Number(res.headers["content-length"]);
  if (Number.isFinite(declaredLength)) stages.push(lengthCheck(declaredLength));
  // Encodings are listed in the order they were applied, so they come off in
  // reverse. One we don't know leaves the body as it came, header included.
  const encodings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const makeDecoders = encodings.map((e) => DECODERS.get(e));
  if (makeDecoders.length > 0 && makeDecoders.every((make) => make !== undefined)) {
    for (const make of makeDecoders.reverse()) stages.push(make!());
    // The decoded length isn't known, and the encoding no longer applies.
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  const source: Readable =
    stages.length === 0
      ? res
      : (pipeline as (...streams: unknown[]) => Readable)(res, ...stages, () => {});
  const stream = Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, { status, statusText: res.statusMessage, headers });
}

/**
 * Fails a body that ends short of its Content-Length. Bun's `node:http` ends
 * the stream quietly when the connection drops, where `fetch` would reject, so
 * a cut-off page would otherwise read as a complete one.
 */
function lengthCheck(expected: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      callback(null, chunk);
    },
    flush(callback) {
      callback(received < expected ? new Error("the response ended early") : null);
    },
  });
}

/** Releases a response's connection without reading the rest of it. */
export async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

export interface GuardedFetchOptions extends OutboundUrlOptions {
  /** Replaces the pinned transport; tests pass a fake. */
  fetchImpl?: typeof fetch;
  /** Ends the whole request, redirects and body read included, when aborted. */
  signal?: AbortSignal;
}

/**
 * Fetches `url`, following up to `MAX_REDIRECTS` redirects with the SSRF guard
 * on each hop and `fetch`'s rules for when a redirect turns into a GET. Returns
 * the final response; its body is not read. A 3xx with no Location is returned
 * as-is for the caller to report.
 */
export async function guardedFetch(
  url: string,
  init: Omit<RequestInit, "signal" | "redirect">,
  { fetchImpl, signal, allowLoopback = false }: GuardedFetchOptions = {},
): Promise<{ response: Response; url: string }> {
  const transport = fetchImpl ?? createPinnedFetch({ allowLoopback });
  let current = (await assertResolvableOutbound(url, { allowLoopback })).toString();
  const origin = new URL(current).origin;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  // The caller's own headers go out untouched until a redirect has to change them.
  let headers: RequestInit["headers"] = init.headers;
  const send = () =>
    transport(current, { ...init, method, body, headers, redirect: "manual", signal });

  let response = await send();
  let redirects = 0;
  while (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) break;
    redirects += 1;
    await discardBody(response);
    if (redirects > MAX_REDIRECTS) throw new TooManyRedirectsError();
    const next = new URL(location, current).toString();
    current = (await assertResolvableOutbound(next, { allowLoopback })).toString();

    const becomesGet =
      (response.status === 303 && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    if (becomesGet) {
      method = "GET";
      body = undefined;
      const withoutBody = new Headers(headers);
      withoutBody.delete("content-type");
      withoutBody.delete("content-length");
      headers = withoutBody;
    }
    if (new URL(current).origin !== origin) {
      if (body != null) throw new CrossOriginRedirectError();
      headers = portableHeaders(headers);
    }
    response = await send();
  }
  return { response, url: current };
}

function portableHeaders(headers: RequestInit["headers"]): Headers {
  const kept = new Headers();
  for (const [name, value] of new Headers(headers)) {
    if (PORTABLE_HEADERS.has(name)) kept.set(name, value);
  }
  return kept;
}

export class CrossOriginRedirectError extends Error {
  constructor() {
    super("refusing to resend a request body to another site");
    this.name = "CrossOriginRedirectError";
  }
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
