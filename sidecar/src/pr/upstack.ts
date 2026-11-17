/**
 * What the layers stacked on a pull request change in it. A layer above
 * targets this PR's head branch, so its diff is against this PR's code: the
 * base side of its hunks names this PR's head lines. A finding on one of
 * those lines may already be fixed upstack, which the reviewer wants to know
 * before asking the author for it again.
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
  /** Null when the layer deletes the file or has no patch to read, so any line may have changed. */
  ranges: LineRange[] | null;
}

export interface UpstackChanges {
  /** The layers directly above, each with what it changes here. */
  layers: { number: number; url: string; files: UpstackFile[]; incomplete: boolean }[];
  /** Why the layers couldn't be read, or that the provider has no stacks. */
  note: string | null;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;

/**
 * The base-side ranges of a patch's hunks. A hunk that only adds lines
 * (`-a,0`) sits after line `a`, so it counts as touching that line.
 */
export function baseRanges(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const match of patch.matchAll(HUNK_HEAD)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    ranges.push({ start: Math.max(1, start), end: Math.max(start, start + count - 1) });
  }
  return ranges;
}

function filesOf(layer: UpstackLayer): UpstackFile[] {
  return layer.files.map((f) => {
    const replaced = f.status === "removed" || f.patch === null;
    return {
      path: f.previousFilename ?? f.filename,
      ranges: replaced ? null : baseRanges(f.patch ?? ""),
    };
  });
}

/** The layers stacked directly on the PR `source` reads, and what each changes in it. */
export async function upstackChanges(source: PrCodeSource): Promise<UpstackChanges> {
  let layers: UpstackLayer[] | null;
  try {
    layers = await source.upstackLayers();
  } catch (e) {
    console.error("[pr] could not read the layers above:", describeError(e));
    return { layers: [], note: "The layers above couldn't be read." };
  }
  if (layers === null) return { layers: [], note: "This provider has no stacked PRs." };
  return {
    layers: layers.map((layer) => ({
      number: layer.number,
      url: layer.url,
      files: filesOf(layer),
      incomplete: layer.incomplete,
    })),
    note: null,
  };
}
