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
 * recalled semantically. Each chunk records its source and position.
 */
export async function ingestDocument(
  memory: MemoryService,
  input: IngestInput,
): Promise<IngestResult> {
  const chunks = chunkText(input.text);
  for (let i = 0; i < chunks.length; i++) {
    await memory.add(chunks[i]!, {
      type: "doc",
      source: input.source,
      title: input.title ?? input.source,
      chunk: i,
      of: chunks.length,
    });
  }
  return { source: input.source, chunks: chunks.length };
}

/** Fetches a URL and returns its body as plain text (HTML stripped). */
export async function fetchUrlText(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; title: string }> {
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
