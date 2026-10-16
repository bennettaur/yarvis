import { BodyTooLargeError, guardedFetch, readCapped } from "../lib/guardedFetch.ts";
import { validateOutboundUrl } from "../lib/urlSafety.ts";
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
      kind: "doc" as const,
      metadata: {
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
 * Fetches a URL and returns its body as plain text (HTML stripped), through
 * `lib/guardedFetch.ts`: the SSRF guard on every redirect hop, a connection
 * pinned to the checked address, a size cap, and a deadline that covers the
 * body read.
 */
export async function fetchUrlText(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<{ text: string; title: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  let bytes: Uint8Array;
  try {
    ({ response: res } = await guardedFetch(
      url,
      { headers: { "User-Agent": "yarvis/0.1 (+local assistant)" } },
      { fetchImpl, signal: controller.signal },
    ));
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);

    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > MAX_FETCH_BYTES) {
      throw new Error(`response too large: ${contentLength} bytes`);
    }
    bytes = await readCapped(res, MAX_FETCH_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      throw new Error(`response too large: exceeded ${MAX_FETCH_BYTES} bytes`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  const body = new TextDecoder().decode(bytes);

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("html")) {
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]!) : url;
    return { text: htmlToText(body), title };
  }
  return { text: body, title: url };
}
