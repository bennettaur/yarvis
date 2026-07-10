import { useMemo } from "react";
import { type DiffRow, parsePatch } from "../../lib/pr/diff";

/** Row background/foreground colors shared by the PR review and workspace diff views. */
export function rowClass(kind: DiffRow["kind"]): string {
  if (kind === "hunk") return "bg-sky-950/60 text-sky-300";
  if (kind === "add") return "bg-emerald-950/50 text-emerald-300";
  if (kind === "del") return "bg-red-950/50 text-red-300";
  return "text-zinc-400";
}

/**
 * A read-only unified-diff renderer: the same patch parsing and row styling the
 * PR review uses, without the line-comment affordances. Used for the workspace
 * changed-file diff tabs, where there is no PR to comment on.
 */
export default function DiffView({ patch }: { patch: string }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);

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
          <span className="whitespace-pre">{row.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
