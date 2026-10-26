/**
 * What the review workspace's agent runs share: the answer-schema helpers that
 * hold a model's output to its limits on the server, the numbered and fenced
 * diff a run reads, and the sweep for context folders a run left behind.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import { describeError } from "../llm/errors.ts";

// ---------------------------------------------------------------------------
// Answer schemas
// ---------------------------------------------------------------------------

/** Cuts text to `max` characters, ending in an ellipsis when it had to cut. */
export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Cuts text to `max` words. Ends at the last full sentence that fits when that
 * keeps most of the allowance, since a summary that stops mid-clause reads
 * worse than a shorter one; otherwise cuts mid-sentence and adds an ellipsis.
 */
export function clipWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(" ");
  const kept = words.slice(0, max);
  for (let end = kept.length; end >= Math.ceil(max / 2); end--) {
    if (/[.!?]["')\]]?$/.test(kept[end - 1] ?? "")) return kept.slice(0, end).join(" ");
  }
  return `${kept.join(" ")}…`;
}

/*
 * Limits reach the model as descriptions, not as `maxLength`/`maxItems`:
 * Claude Code rejects structured output that breaks a JSON Schema bound, and a
 * model told its answer is too long can refuse to shorten it and finish with
 * no structured output at all — losing a whole paid-for run over one long
 * sentence. The transforms below hold the limits instead.
 */

/** A string cut to `max` characters. */
export function boundedText(max: number) {
  return z
    .string()
    .transform((s) => clip(s, max))
    .meta({ description: `At most ${max} characters.` });
}

/** An array cut to `max` items. */
export function boundedList<T extends z.ZodType>(item: T, max: number) {
  return z
    .array(item)
    .transform((items) => items.slice(0, max))
    .meta({ description: `At most ${max} items.` });
}

export function positiveInt(n: unknown): number | undefined {
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Optional in the answer; models write null for "none" as often as they leave a key out. */
export const optionalPath = z
  .string()
  .nullish()
  .transform((p) => (p?.trim() ? clip(p, 500) : undefined));

export const optionalLine = z.number().nullish().transform(positiveInt);

/** A range with either end missing or invalid reads as the other end; with neither, no range. */
export const lineRangeSchema = z
  .object({ start: z.number().nullish(), end: z.number().nullish() })
  .nullish()
  .transform((r) => {
    const start = positiveInt(r?.start);
    const end = positiveInt(r?.end);
    const a = start ?? end;
    const b = end ?? start;
    if (a === undefined || b === undefined) return undefined;
    return { start: Math.min(a, b), end: Math.max(a, b) };
  });

/**
 * A path as the repo knows it. Agents sometimes cite the absolute path Read
 * showed them, which would match no changed file and no other check's finding.
 */
export function repoPath(path: string, checkoutDir?: string): string {
  let p = path.trim();
  if (checkoutDir) {
    const root = checkoutDir.replace(/\/+$/, "");
    if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  }
  return p.replace(/^(\.\/)+/, "");
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Prefixes every line of a hunk with the line number it has in its file: the
 * head's for added and context lines, the base's (marked `b`) for removed
 * ones. A model reading a diff cites the line numbers in front of it, and
 * without these those are the diff file's own, which point nowhere.
 */
export function numberPatch(patch: string): string {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      out.push(line);
    } else if (!inHunk || line.startsWith("\\") || line === "") {
      out.push(line);
    } else if (line.startsWith("+")) {
      out.push(`+${String(newLine++).padStart(6)}  ${line.slice(1)}`);
    } else if (line.startsWith("-")) {
      out.push(`-${`b${oldLine++}`.padStart(6)}  ${line.slice(1)}`);
    } else if (line.startsWith(" ")) {
      oldLine++;
      out.push(` ${String(newLine++).padStart(6)}  ${line.slice(1)}`);
    } else {
      // The next file's header in a concatenated diff.
      inHunk = false;
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * Patches numbered with {@link numberPatch} and fenced as one block tagged
 * `tag`, with the line each path's patch starts on in the file the caller
 * writes. A patch that is null or empty is left out; `header` adds a line
 * naming the file before its patch.
 */
export function fencedDiff(
  items: { path: string; patch: string | null }[],
  tag: string,
  header?: (path: string) => string,
): { diff: string; startLine: Map<string, number> } {
  const nonce = newNonce();
  const startLine = new Map<string, number>();
  const parts: string[] = [];
  // The warning and the opening tag come first.
  let line = 3;
  for (const { path, patch } of items) {
    if (!patch) continue;
    startLine.set(path, line);
    const numbered = `${header ? `${header(path)}\n` : ""}${numberPatch(patch)}`;
    const text = numbered.endsWith("\n") ? numbered : `${numbered}\n`;
    parts.push(text);
    line += text.split("\n").length - 1;
  }
  const body = parts.join("").replace(/\n$/, "");
  return { diff: `${untrustedWarning(nonce, tag)}\n${fence(body, nonce, tag)}\n`, startLine };
}

// ---------------------------------------------------------------------------
// Context folders
// ---------------------------------------------------------------------------

/**
 * Removes the context folders named `prefix…` that a run left behind — a
 * sidecar killed mid-run never gets to. Only ones older than a run can last
 * (`maxAgeMs`, plus five minutes' grace), since another instance shares the
 * temp folder and may have a run reading its own.
 */
export function sweepContextDirs(options: {
  prefix: string;
  maxAgeMs: number;
  root?: string;
  now?: number;
}): number {
  const { prefix, maxAgeMs, root = tmpdir(), now = Date.now() } = options;
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix)) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs + 5 * 60 * 1000) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch (e) {
      console.error(`[agent-context] could not remove ${path}:`, describeError(e));
    }
  }
  return removed;
}
