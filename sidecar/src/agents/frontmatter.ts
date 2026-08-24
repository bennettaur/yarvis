/**
 * Parsing the YAML frontmatter of an agent definition file.
 *
 * Deliberately a strict, tiny subset rather than a YAML dependency: what an agent
 * file needs is scalars and flat lists, and a real YAML parser would silently
 * accept nested structures this format has no meaning for. Anything outside the
 * subset is an error naming the file and line, because a misparsed definition is
 * a prompt or a tool list that isn't what the author wrote.
 *
 * The parser records only what the syntax says — a scalar, or a list written as a
 * block or in brackets. It does *not* guess that a comma means a list: a
 * description is prose and prose has commas in it, and a `description` silently
 * becoming a two-element list is a definition that fails to load for a reason its
 * author cannot see. Splitting a comma-separated scalar is the reader's job, in
 * {@link asList}, where the caller already knows the key is list-shaped.
 */

export interface Frontmatter {
  /** Scalars keep their raw string form; lists are always string arrays. */
  values: Record<string, string>;
  lists: Record<string, string[]>;
}

export interface ParsedDocument extends Frontmatter {
  /** Everything after the closing fence — the agent's system prompt. */
  body: string;
}

export class FrontmatterError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    message: string,
  ) {
    super(`${file}:${line}: ${message}`);
  }
}

/** Strips one layer of matching quotes, so `name: "work-scout"` reads as expected. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(".*"|'.*')$/s.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

/** Splits an inline `a, b, c` list, dropping empties so a trailing comma is fine. */
function splitInline(value: string): string[] {
  return value
    .split(",")
    .map((item) => unquote(item))
    .filter((item) => item.length > 0);
}

/**
 * Splits a document into its frontmatter block and body. The opening `---` must
 * be the first line: a file without one is a definition missing its
 * configuration, and guessing that the whole file is a prompt would give an agent
 * with no name and no tools rather than an error.
 */
export function parseDocument(file: string, content: string): ParsedDocument {
  // A BOM or CRLF line endings are what a file edited on another machine arrives
  // with, and neither should be a parse error.
  const normalized = content.replace(/^﻿/, "").replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new FrontmatterError(file, 1, "expected a '---' frontmatter fence on the first line");
  }
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closing === -1) {
    throw new FrontmatterError(file, lines.length, "frontmatter is never closed with '---'");
  }

  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  /** The key a `- item` line belongs to, or null outside a block list. */
  let openList: string | null = null;

  for (let i = 1; i < closing; i++) {
    const raw = lines[i]!;
    const lineNumber = i + 1;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (raw.includes("\t")) {
      throw new FrontmatterError(file, lineNumber, "tabs are not valid indentation here");
    }

    const listItem = raw.match(/^\s+-\s*(.*)$/);
    if (listItem) {
      if (!openList) {
        throw new FrontmatterError(file, lineNumber, "list item with no key above it");
      }
      const item = unquote(listItem[1] ?? "");
      if (item) lists[openList]?.push(item);
      continue;
    }

    const pair = raw.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!pair) {
      throw new FrontmatterError(
        file,
        lineNumber,
        `expected 'key: value' or a '- item' list entry, got ${JSON.stringify(raw)}`,
      );
    }
    const key = pair[1] as string;
    const rest = pair[2] as string;
    if (key in values || key in lists) {
      throw new FrontmatterError(file, lineNumber, `duplicate key '${key}'`);
    }

    const inline = rest.trim();
    // Block scalars: `>` folds the indented lines into one, `|` keeps their
    // newlines, and a trailing `-` drops the final newline. Supported because a
    // description worth reading is often two lines long, and an author writing
    // ordinary YAML should not have to discover that this one place forbids it.
    const blockScalar = inline.match(/^([>|])([-+]?)$/);
    if (blockScalar) {
      const [, style] = blockScalar as unknown as [string, string, string];
      const collected: string[] = [];
      let j = i + 1;
      for (; j < closing; j++) {
        const next = lines[j]!;
        if (next.trim() === "") {
          collected.push("");
          continue;
        }
        if (!/^\s/.test(next)) break;
        collected.push(next.trim());
      }
      i = j - 1;
      values[key] =
        style === ">"
          ? collected.join(" ").replace(/\s+/g, " ").trim()
          : collected.join("\n").trim();
      openList = null;
      continue;
    }
    if (inline === "") {
      // A bare key opens a block list; an empty one stays an empty list rather
      // than an empty string, so `tools:` with nothing under it means "no tools"
      // instead of "one tool called ''".
      lists[key] = [];
      openList = key;
      continue;
    }
    openList = null;
    // Bracketed or comma-separated inline lists, e.g. `tools: [a, b]` / `a, b`.
    const bracketed = inline.match(/^\[(.*)\]$/s);
    if (bracketed) {
      lists[key] = splitInline(bracketed[1] ?? "");
      continue;
    }
    values[key] = unquote(inline);
  }

  return {
    values,
    lists,
    body: lines
      .slice(closing + 1)
      .join("\n")
      .trim(),
  };
}

/**
 * Reads a list-shaped key, however it was written: a block list, brackets, a
 * comma-separated scalar, or a single bare value. Only keys the caller knows are
 * lists come through here, which is what lets a comma stay ordinary punctuation
 * everywhere else.
 */
export function asList(parsed: Frontmatter, key: string): string[] | undefined {
  if (key in parsed.lists) return parsed.lists[key];
  const scalar = parsed.values[key];
  if (scalar === undefined) return undefined;
  if (!scalar.length) return [];
  return splitInline(scalar);
}

/** Reads a boolean, rejecting anything that isn't obviously one. */
export function asBoolean(parsed: Frontmatter, key: string, file: string): boolean | undefined {
  const raw = parsed.values[key];
  if (raw === undefined) return undefined;
  if (/^(true|yes)$/i.test(raw)) return true;
  if (/^(false|no)$/i.test(raw)) return false;
  throw new FrontmatterError(file, 1, `'${key}' must be true or false, got ${JSON.stringify(raw)}`);
}

/** Reads a positive integer, rejecting anything else. */
export function asInteger(parsed: Frontmatter, key: string, file: string): number | undefined {
  const raw = parsed.values[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new FrontmatterError(
      file,
      1,
      `'${key}' must be a positive whole number, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}
