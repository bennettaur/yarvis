import { type ExpandedRow, hunkRightStart } from "../../lib/pr/expand";

/** A run of consecutive changed lines, as a fraction of the file's height. */
interface Band {
  top: number;
  height: number;
  added: boolean;
}

/**
 * Minimum band height, in percent. A one-line change in a thousand-line file
 * works out to a tenth of a percent and would render as nothing at all, so
 * every band is floored at something the eye can actually catch.
 */
const MIN_BAND = 0.6;

/**
 * Collapses the changed lines into bands positioned against the whole file.
 * Adjacent changes merge into one band, and a band that contains any addition
 * is drawn as an addition — the point is "something changed here", not an exact
 * accounting of which side it was on.
 */
export function changeBands(rows: ExpandedRow[], totalLines: number): Band[] {
  if (totalLines === 0) return [];
  const bands: Band[] = [];
  let start: number | null = null;
  let end = 0;
  let added = false;
  // The last right-side line seen anywhere, which is what a deletion attaches
  // to. Tracked separately from `end` (the open band's extent) because `end`
  // belongs to a band and is meaningless once that band closes — reusing it
  // placed a deletion-only hunk at the previous band's position instead of its
  // own, putting the marker in the wrong part of the file entirely.
  let lastLine = 0;

  const close = () => {
    if (start === null) return;
    const top = ((start - 1) / totalLines) * 100;
    bands.push({ top, height: Math.max(((end - start + 1) / totalLines) * 100, MIN_BAND), added });
    start = null;
    added = false;
  };

  for (const item of rows) {
    if (item.kind !== "row") continue;
    // A hunk that only deletes has no row carrying a right-side line at all —
    // where a header is rendered, its position in the new file exists solely
    // there. Without reading it, such a hunk inherits whatever line the
    // previous hunk left behind and its marker lands in the wrong part of the
    // file. A header is dropped once the line above it is revealed, and then
    // that revealed line carries the position instead.
    if (item.row.kind === "hunk") {
      const start = hunkRightStart(item.row.text);
      if (start !== null) lastLine = start - 1;
      close();
      continue;
    }
    if (item.row.rightLine != null) lastLine = item.row.rightLine;
    if (item.row.kind !== "add" && item.row.kind !== "del") {
      close();
      continue;
    }
    // Deletions carry no right-side line of their own, so they sit where the
    // reader sees them: just after the last line that had one.
    const line = item.row.rightLine ?? lastLine + 1;
    if (start === null) start = line;
    end = Math.max(start, line);
    if (item.row.kind === "add") added = true;
  }
  close();
  return bands;
}

/**
 * A strip down the edge of a file marking where in it the changes fall.
 *
 * Positions are fractions of the whole file, so at a glance a reader can tell a
 * change clustered at the top from one scattered through the file — something
 * neither the patch nor the scrollbar conveys once the file is shown in full.
 */
export default function ChangeMinimap({
  rows,
  totalLines,
}: {
  rows: ExpandedRow[];
  totalLines: number;
}) {
  const bands = changeBands(rows, totalLines);
  if (bands.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      title={`${bands.length} changed ${bands.length === 1 ? "region" : "regions"} across ${totalLines} lines`}
      className="pointer-events-none absolute inset-y-0 right-0 w-1.5 bg-zinc-900/60"
    >
      {bands.map((band) => (
        <div
          key={`${band.top}-${band.height}`}
          style={{ top: `${band.top}%`, height: `${band.height}%` }}
          className={`absolute inset-x-0 ${band.added ? "bg-emerald-500/70" : "bg-red-500/70"}`}
        />
      ))}
    </div>
  );
}
