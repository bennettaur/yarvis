import { parse as parseYaml, YAMLParseError } from "yaml";

/**
 * Reading the YAML frontmatter of an agent definition file.
 *
 * Splitting the document is ours; parsing the block is `yaml`'s. An earlier
 * hand-rolled subset looked cheap and then quietly turned every description
 * containing a comma into a list — the class of bug you get for owning a parser
 * you didn't want to own.
 *
 * What stays ours is *validation*: YAML will happily hand back a nested map or a
 * misspelled key, and this format has no meaning for either. Every reader below
 * fails loudly with the file named, because a half-understood definition is a
 * prompt or a tool list that isn't what its author wrote.
 */

export interface ParsedDocument {
  /** The frontmatter mapping, keys unvalidated. */
  data: Record<string, unknown>;
  /** Everything after the closing fence — the agent's system prompt. */
  body: string;
}

export class FrontmatterError extends Error {
  constructor(
    readonly file: string,
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? `${file}: ${message}` : `${file}:${line}: ${message}`);
  }
}

/**
 * Splits a document at its `---` fences and parses the frontmatter. The opening
 * fence must be the first line: a file without one is a definition missing its
 * configuration, and treating the whole file as a prompt would produce an agent
 * with no name and no tools rather than an error.
 */
export function parseDocument(file: string, content: string): ParsedDocument {
  // A BOM or CRLF line endings are what a file edited on another machine arrives
  // with, and neither should be a parse error.
  const normalized = content.replace(/^﻿/, "").replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new FrontmatterError(file, "expected a '---' frontmatter fence on the first line", 1);
  }
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closing === -1) {
    throw new FrontmatterError(file, "frontmatter is never closed with '---'", lines.length);
  }

  const block = lines.slice(1, closing).join("\n");
  let parsed: unknown;
  try {
    // Merge keys off: `<<:` is a feature of YAML this format has no use for, and
    // it is the one that lets a document pull in structure from elsewhere.
    parsed = parseYaml(block, { merge: false });
  } catch (e) {
    if (e instanceof YAMLParseError) {
      // The parser counts from the start of the block, which is the line after
      // the opening fence — and it points at where the offending construct
      // began, not necessarily where it went wrong.
      const line = (e.linePos?.[0]?.line ?? 0) + 1;
      throw new FrontmatterError(file, e.message.split("\n")[0] ?? "invalid YAML", line);
    }
    throw new FrontmatterError(file, e instanceof Error ? e.message : String(e));
  }

  if (parsed === null || parsed === undefined) {
    throw new FrontmatterError(file, "frontmatter is empty", 1);
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FrontmatterError(file, "frontmatter must be a mapping of keys to values", 1);
  }

  return {
    data: parsed as Record<string, unknown>,
    body: lines
      .slice(closing + 1)
      .join("\n")
      .trim(),
  };
}

/**
 * Rejects keys this format has no meaning for. YAML cannot know the schema, so a
 * `tool:` where `tools:` was meant would otherwise be a specialist that silently
 * has no tools — the mistake most worth catching, because nothing downstream
 * looks wrong.
 */
export function assertKnownKeys(
  file: string,
  data: Record<string, unknown>,
  known: readonly string[],
): void {
  const unknown = Object.keys(data).filter((key) => !known.includes(key));
  if (unknown.length) {
    throw new FrontmatterError(
      file,
      `unknown key(s): ${unknown.join(", ")}. Known keys: ${known.join(", ")}`,
      1,
    );
  }
}

/** A required non-empty string. */
export function asRequiredString(file: string, data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new FrontmatterError(file, `'${key}' is required and must be text`, 1);
  }
  return value.trim();
}

/** An optional string, rejecting a value of some other type. */
export function asString(
  file: string,
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new FrontmatterError(file, `'${key}' must be text`, 1);
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

/**
 * A list, however it was written: a YAML sequence, or a comma-separated scalar.
 * The comma form isn't YAML — `tools: a, b` is one string — but it is how these
 * files are written by hand elsewhere, so it is accepted rather than becoming a
 * tool named "a, b".
 */
export function asList(
  file: string,
  data: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new FrontmatterError(file, `'${key}' item ${i + 1} must be text`, 1);
      }
      return item.trim();
    });
  }
  if (typeof value !== "string") {
    throw new FrontmatterError(file, `'${key}' must be a list or a comma-separated string`, 1);
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * A boolean, plus the `yes`/`no` spellings a person reaches for. Those are not
 * booleans in YAML 1.2 — the version this parser implements — so they arrive as
 * strings; rejecting them would be technically right and useless, since
 * `enabled: no` obviously means off.
 */
export function asBoolean(
  file: string,
  data: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|on)$/i.test(value.trim())) return true;
    if (/^(false|no|off)$/i.test(value.trim())) return false;
  }
  throw new FrontmatterError(file, `'${key}' must be true or false`, 1);
}

/** A positive whole number. */
export function asInteger(
  file: string,
  data: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new FrontmatterError(file, `'${key}' must be a positive whole number`, 1);
  }
  return value;
}
