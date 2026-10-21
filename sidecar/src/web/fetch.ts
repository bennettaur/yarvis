import { assertResolvableOutbound } from "../lib/urlSafety.ts";

/** Hard cap on a page's body, after which the read is aborted. */
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/** Covers the whole redirect chain and the body read, so a slow host can't stall a turn. */
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/**
 * Content types read as text. Anything else (PDFs, images, archives) is refused
 * rather than decoded into noise the model would then try to make sense of.
 */
const TEXT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];

export class WebFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebFetchError";
  }
}

export interface FetchedPage {
  /** Where the body came from, after redirects. */
  url: string;
  /** The media type without parameters, e.g. `text/html`. */
  contentType: string;
  body: string;
}

/** A media type we are willing to repeat back in an error; anything else may be text the server chose. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;

/** What a browser would sniff as HTML when the server names no type. */
const HTML_START = /^\s*(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i;

export interface FetchWebPageOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fetches a public web page as text.
 *
 * The SSRF guard runs on every redirect hop, not just the first, so a page that
 * redirects to a LAN or metadata address is refused — the same loop as
 * `guardedFetch` in `voice/speech.ts`, with the deadline also covering the body
 * read. No cookies or credentials are sent: this reads the page as an anonymous
 * visitor would see it.
 */
export async function fetchWebPage(
  url: string,
  { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS }: FetchWebPageOptions = {},
): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init: RequestInit = {
    headers: {
      "User-Agent": "yarvis/0.1 (+local assistant)",
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
    },
    redirect: "manual",
    signal: controller.signal,
  };
  try {
    let current = (await assertResolvableOutbound(url)).toString();
    let res = await fetchImpl(current, init);
    let redirects = 0;
    while (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw new WebFetchError("too many redirects");
      current = (await assertResolvableOutbound(new URL(location, current).toString())).toString();
      res = await fetchImpl(current, init);
    }
    if (!res.ok) throw new WebFetchError(`the page answered ${res.status}`);

    const header = res.headers.get("content-type") ?? "";
    const declared = (header.split(";")[0] ?? "").trim().toLowerCase();
    if (declared && !TEXT_TYPES.includes(declared)) {
      const named = MEDIA_TYPE.test(declared) ? `${declared} content` : "that content type";
      throw new WebFetchError(`can't read ${named}, only web pages and plain text`);
    }
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > MAX_FETCH_BYTES) {
      throw new WebFetchError(`the page is too large (${contentLength} bytes)`);
    }

    const body = decode(await readCapped(res), header);
    // With no declared type a browser sniffs, so a server can't skip the
    // hidden-text screen by leaving the header off.
    const contentType =
      declared || (HTML_START.test(body.slice(0, 1024)) ? "text/html" : "text/plain");
    return { url: current, contentType, body };
  } catch (e) {
    if (controller.signal.aborted) throw new WebFetchError("the page took too long to load");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Streams the body so a response with a missing or lying Content-Length is cut off. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FETCH_BYTES) {
      await reader.cancel();
      throw new WebFetchError(`the page is larger than ${MAX_FETCH_BYTES} bytes`);
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

/** Decodes with the charset the server named, falling back to UTF-8 for one `TextDecoder` rejects. */
function decode(bytes: Uint8Array, contentTypeHeader: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentTypeHeader)?.[1];
  try {
    return new TextDecoder((charset ?? "utf-8") as Bun.Encoding).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
