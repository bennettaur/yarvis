/**
 * What the layer stacked on a pull request changes in it. A layer above
 * targets this PR's head branch, so while it is built on this PR's current
 * head its diff is against this PR's code: the base side of its hunks names
 * this PR's head lines. A finding on one of those lines may already be fixed
 * upstack, which the reviewer wants to know before asking the author for it
 * again.
 */

import { describeError } from "../llm/errors.ts";
import type { PrCodeSource, UpstackLayer } from "./source.ts";

/** Lines on this PR's head that a layer above changes, both ends included. */
export interface LineRange {
  start: number;
  end: number;
}

export interface UpstackFile {
  /** This PR's path for it, before any rename the layer makes. */
  path: string;
  /** Null when the layer deletes the file or its patch can't be read, so any line may have changed. */
  ranges: LineRange[] | null;
}

export interface UpstackChanges {
  /** This PR's head as the provider has it now, which the layers' line numbers are against. */
  headSha: string | null;
  /** The layers directly above, each with what it changes here. */
  layers: { number: number; url: string; stale: boolean; files: UpstackFile[] }[];
  /** Why the layers couldn't be read, or that the provider has no stacks. */
  note: string | null;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;

/**
 * The base-side ranges of a patch's hunks. A hunk that only adds lines
 * (`-a,0`) sits after line `a`, so it counts as touching that line; one that
 * adds a whole new file (`-0,0`) touches none.
 */
export function baseRanges(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const match of patch.matchAll(HUNK_HEAD)) {
    const start = Number(match[1]);
    if (start === 0) continue;
    const count = match[2] === undefined ? 1 : Number(match[2]);
    ranges.push({ start, end: Math.max(start, start + count - 1) });
  }
  return ranges;
}

function rangesOf(f: UpstackLayer["files"][number]): LineRange[] | null {
  if (f.status === "removed") return null;
  if (f.patch !== null) return baseRanges(f.patch);
  // GitHub leaves out the patch of a pure rename, which changes no lines.
  return f.status === "renamed" && f.additions === 0 && f.deletions === 0 ? [] : null;
}

/** The layers stacked directly on the PR `source` reads, and what each changes in it. */
export async function upstackChanges(source: PrCodeSource): Promise<UpstackChanges> {
  let read: Awaited<ReturnType<PrCodeSource["upstackLayers"]>>;
  try {
    read = await source.upstackLayers();
  } catch (e) {
    console.error("[pr] could not read the layers above:", describeError(e));
    return { headSha: null, layers: [], note: "The layers above couldn't be read." };
  }
  if (read === null) {
    return { headSha: null, layers: [], note: "This provider has no stacked PRs." };
  }
  return {
    headSha: read.headSha,
    layers: read.layers.map((layer) => ({
      number: layer.number,
      url: layer.url,
      stale: layer.stale,
      files: layer.files.map((f) => ({
        path: f.previousFilename ?? f.filename,
        ranges: rangesOf(f),
      })),
    })),
    note: null,
  };
}
