import { assertResolvableOutbound, validateOutboundUrl } from "../lib/urlSafety.ts";
import type { MemoryService } from "./index.ts";

/** Hard cap on a fetched document, after which the fetch is aborted. */
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/** Per-fetch wall-clock cap so a slow internal host can't block a request thread. */
const FETCH_TIMEOUT_MS = 15_000;

/** Target size for a single embedded chunk, in characters. */
const CHUNK_CHARS = 1000;

/**
 * Strips HTML to readable text: drops script/style blocks, removes tags, and
 * decodes the handful of entities that show up most. Deliberately simple — good
 * enough to feed article text into the embedder, not a full HTML parser.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits text into chunks of roughly CHUNK_CHARS, breaking on paragraph then
 * sentence boundaries so chunks stay semantically coherent for recall.
 */
export function chunkText(text: string, maxChars = CHUNK_CHARS): string[] {
  const clean = text.trim();
  if (clean.length === 0) return [];
  if (clean.length <= maxChars) return [clean];

  // Split into paragraph/sentence-ish units, then greedily pack into chunks.
  const units = clean.split(/(?<=[.!?])\s+|\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const piece = unit.trim();
    if (!piece) continue;
    if (current.length + piece.length + 1 > maxChars && current) {
      chunks.push(current.trim());
      current = "";
    }
    // A single oversized unit is hard-split so nothing is dropped.
    if (piece.length > maxChars) {
      for (let i = 0; i < piece.length; i += maxChars) {
        chunks.push(piece.slice(i, i + maxChars).trim());
      }
      continue;
    }
    current += (current ? " " : "") + piece;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export interface IngestInput {
  /** Raw text to ingest. For URLs, fetch first and pass the body here. */
  text: string;
  /** Human label for the source (URL or title), stored on each chunk. */
  source: string;
  title?: string;
}

export interface IngestResult {
  source: string;
  chunks: number;
}

/**
 * Chunks a document and stores each chunk as a `doc` memory so it can be
 * recalled semantically. Each chunk records its source and position. Chunks are
 * embedded and inserted in a single batch.
 */
export async function ingestDocument(
  memory: MemoryService,
  input: IngestInput,
): Promise<IngestResult> {
  const chunks = chunkText(input.text);
  await memory.addMany(
    chunks.map((content, i) => ({
      content,
      metadata: {
        type: "doc",
        source: input.source,
        title: input.title ?? input.source,
        chunk: i,
        of: chunks.length,
      },
    })),
  );
  return { source: input.source, chunks: chunks.length };
}

/**
 * SSRF guard: validates scheme, rejects URLs with embedded credentials, and
 * blocks private / loopback / link-local addresses. The static-only variant
 * (no DNS) lets callers reject obviously-bad URLs at CRUD time; the resolver
 * variant in `lib/urlSafety` is called immediately before the actual fetch.
 */
export function assertFetchableUrl(url: string): URL {
  return validateOutboundUrl(url);
}

/**
 * Fetches a URL and returns its body as plain text (HTML stripped). Enforces
 * DNS-resolved SSRF protection, rejects redirects that would jump to a
 * disallowed host, caps body size, and times out on slow hosts.
 */
export async function fetchUrlText(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; title: string }> {
  await assertResolvableOutbound(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": "yarvis/0.1 (+local assistant)" },
      // Manual redirect handling: re-validate the target host before following,
      // so a 302 to an internal address can't bypass the SSRF guard.
      redirect: "manual",
      signal: controller.signal,
    });
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hops++ >= 5) throw new Error("too many redirects");
      const next = new URL(res.headers.get("location")!, url).toString();
      await assertResolvableOutbound(next);
      res = await fetchImpl(next, {
        headers: { "User-Agent": "yarvis/0.1 (+local assistant)" },
        redirect: "manual",
        signal: controller.signal,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);

  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FETCH_BYTES) {
    throw new Error(`response too large: ${contentLength} bytes`);
  }

  // Stream the body so an oversize response (without/with lying Content-Length)
  // is aborted before it fills memory.
  const reader = res.body?.getReader();
  if (!reader) throw new Error("empty response body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FETCH_BYTES) {
      await reader.cancel();
      throw new Error(`response too large: exceeded ${MAX_FETCH_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = new TextDecoder().decode(merged);

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("html")) {
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]!) : url;
    return { text: htmlToText(body), title };
  }
  return { text: body, title: url };
}
