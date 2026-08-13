import { useMemo } from "react";
import { type DiffRow, parsePatch } from "../../lib/pr/diff";
import { highlightDiff, rowHtml } from "../../lib/pr/highlight";

/** Row background/foreground colors shared by the PR review and workspace diff views. */
export function rowClass(kind: DiffRow["kind"]): string {
  if (kind === "hunk") return "bg-sky-950/60 text-sky-300";
  if (kind === "add") return "bg-emerald-950/50 text-emerald-300";
  if (kind === "del") return "bg-red-950/50 text-red-300";
  return "text-zinc-400";
}

/**
 * A line of code inside a diff row, syntax-colored where we have a grammar for
 * the file and plain otherwise. The two render the same apart from the token
 * colors, so a file we can't color is not a different-looking diff.
 *
 * The markup comes from highlight.js, which escapes every character of the
 * source it wraps — nothing out of the file itself reaches the DOM as HTML.
 */
export function CodeText({
  html,
  text,
  wrap = false,
  className = "",
}: {
  /** Colored HTML for the line, or null to render it as plain text. */
  html: string | null;
  text: string;
  /**
   * Wraps a line too long for the space it has instead of running it off
   * sideways. For a view whose width is shared — the side-by-side diff, where
   * a line spilling out of its column hides the other file. `anywhere` rather
   * than `break-word` so a line with no break opportunity at all, a minified
   * bundle or a base64 blob, wraps as well.
   */
  wrap?: boolean;
  className?: string;
}) {
  // `pre-wrap` either way, so indentation reads the same wrapped or not.
  const flow = wrap ? "whitespace-pre-wrap wrap-anywhere" : "whitespace-pre";
  if (!html) {
    return <span className={`${flow} ${className}`}>{text || " "}</span>;
  }
  return (
    <span
      className={`syntax ${flow} ${className}`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes the source it colors
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * A read-only unified-diff renderer: the same patch parsing and row styling the
 * PR review uses, without the line-comment affordances. Used for the workspace
 * changed-file diff tabs, where there is no PR to comment on.
 */
export default function DiffView({ patch, path }: { patch: string; path: string }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const highlight = useMemo(() => highlightDiff(rows, path), [rows, path]);

  if (patch.trim().length === 0) {
    return <p className="p-3 text-xs text-zinc-600">No textual diff (binary or unchanged).</p>;
  }

  return (
    <div className="h-full overflow-auto bg-zinc-950 font-mono text-xs leading-relaxed">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable render of an immutable patch
        <div key={i} className={`flex ${rowClass(row.kind)}`}>
          <span className="w-12 shrink-0 select-none pr-2 text-right text-zinc-600">
            {row.rightLine ?? ""}
          </span>
          <CodeText html={rowHtml(row, highlight)} text={row.text} />
        </div>
      ))}
    </div>
  );
}
