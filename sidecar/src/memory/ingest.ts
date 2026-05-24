import type { MemoryService } from "./index.ts";

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
 * Best-effort SSRF guard: only http(s) and not an obvious internal host. This
 * runs in a localhost-bound sidecar, so it blocks the easy mistakes (loopback,
 * link-local metadata, RFC-1918 ranges) rather than resolving DNS.
 */
export function assertFetchableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http(s) urls can be ingested");
  }
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
  if (blocked) throw new Error("refusing to fetch an internal host");
  return parsed;
}

/** Fetches a URL and returns its body as plain text (HTML stripped). */
export async function fetchUrlText(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; title: string }> {
  assertFetchableUrl(url);
  const res = await fetchImpl(url, {
    headers: { "User-Agent": "yarvis/0.1 (+local assistant)" },
  });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (contentType.includes("html")) {
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]!) : url;
    return { text: htmlToText(body), title };
  }
  return { text: body, title: url };
}
