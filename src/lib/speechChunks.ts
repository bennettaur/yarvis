/**
 * Splits a streaming assistant reply into speakable chunks.
 *
 * Waiting for the whole reply before synthesizing it would put the model's full
 * generation time in front of the first sound. Instead each finished sentence
 * leaves here as soon as it lands, so speech starts a sentence after the model
 * does. Chunks are also what keeps a long reply inside the synthesis endpoint's
 * per-call limit.
 *
 * Markdown is prose to a reader and noise to a listener: emphasis markers, link
 * targets and list bullets are stripped, and fenced code is dropped entirely
 * rather than spelled out symbol by symbol.
 */

/** Below this a sentence end is ignored, so "Hi." doesn't become its own call. */
const DEFAULT_MIN_CHARS = 60;

/**
 * Above this a chunk is cut at a word break even without a sentence end. Chosen
 * for prosody, but it must also stay at or below the synthesis route's
 * `MAX_SPEECH_CHARS` — a longer chunk is rejected outright and its sentence
 * never gets spoken.
 */
const DEFAULT_MAX_CHARS = 320;

const FENCE = "```";

/** Strips markdown that reads as noise aloud and collapses the whitespace. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Index just past the first sentence end in `text`, or null when none is far
 * enough in yet. A terminator counts only when the character after it is
 * already in the buffer and is whitespace — otherwise "3.5" and "e.g." split
 * mid-word, and a terminator at the very end may still be growing.
 *
 * The search stops at `maxChars` whatever it finds there. Scanning the whole
 * buffer for a terminator first would let one large delta — a model that emits
 * a paragraph in a single event rather than token by token — produce a chunk
 * longer than the synthesis endpoint accepts, which comes back as a 400 and
 * drops that sentence from the spoken reply entirely.
 */
function findBoundary(text: string, minChars: number, maxChars: number): number | null {
  const limit = Math.min(text.length, maxChars);
  for (let i = 0; i < limit; i++) {
    const ch = text.charAt(i);
    if (ch === "\n") return i + 1;
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
    // Closing quotes and brackets belong to the sentence that ends before them.
    let end = i + 1;
    while (end < text.length && "\"')]".includes(text.charAt(end))) end++;
    if (end >= text.length) continue;
    if (!/\s/.test(text.charAt(end))) continue;
    if (end >= minChars) return end;
  }
  if (text.length >= maxChars) {
    const wordBreak = text.lastIndexOf(" ", maxChars);
    return wordBreak > minChars ? wordBreak : maxChars;
  }
  return null;
}

export interface SentenceSplitter {
  /** Feeds a stream delta, returning whatever chunks it completed. */
  push(delta: string): string[];
  /** Ends the stream, returning the trailing partial sentence as a last chunk. */
  flush(): string[];
}

export interface SentenceSplitterOptions {
  minChars?: number;
  maxChars?: number;
}

export function createSentenceSplitter(options: SentenceSplitterOptions = {}): SentenceSplitter {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  let buffer = "";
  let inFence = false;

  function drain(final: boolean): string[] {
    const chunks: string[] = [];
    const emit = (raw: string) => {
      const text = speakableText(raw);
      if (text) chunks.push(text);
    };

    while (true) {
      if (inFence) {
        const close = buffer.indexOf(FENCE);
        if (close === -1) {
          // Still inside the block: hold the rest, and on a stream that ended
          // mid-fence drop it rather than reading code aloud.
          if (final) buffer = "";
          break;
        }
        buffer = buffer.slice(close + FENCE.length);
        inFence = false;
        continue;
      }

      const open = buffer.indexOf(FENCE);
      const speakable = open === -1 ? buffer : buffer.slice(0, open);
      const boundary = findBoundary(speakable, minChars, maxChars);
      if (boundary !== null) {
        emit(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary);
        continue;
      }
      if (open !== -1) {
        emit(speakable);
        buffer = buffer.slice(open + FENCE.length);
        inFence = true;
        continue;
      }
      if (final) {
        emit(buffer);
        buffer = "";
      }
      break;
    }
    return chunks;
  }

  return {
    push(delta: string): string[] {
      buffer += delta;
      return drain(false);
    },
    flush(): string[] {
      return drain(true);
    },
  };
}
