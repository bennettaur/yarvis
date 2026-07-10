import { useEffect, useMemo, useState } from "react";
import { type DiffRow, parsePatch } from "../../lib/pr/diff";
import { workspaceRepoFileDiff } from "../../lib/workspaces";

function rowClass(kind: DiffRow["kind"]): string {
  if (kind === "hunk") return "bg-sky-950/60 text-sky-300";
  if (kind === "add") return "bg-emerald-950/50 text-emerald-300";
  if (kind === "del") return "bg-red-950/50 text-red-300";
  return "text-zinc-400";
}

export default function WorkspaceFileDiff({
  workspaceId,
  repoId,
  path,
}: {
  workspaceId: string;
  repoId: string;
  path: string;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    workspaceRepoFileDiff(workspaceId, repoId, path)
      .then((p) => {
        if (live) {
          setPatch(p);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [workspaceId, repoId, path]);

  const rows = useMemo(() => (patch ? parsePatch(patch) : []), [patch]);

  if (loading) return <div className="p-4 text-sm text-zinc-500">Loading diff…</div>;
  if (error) return <div className="p-4 text-sm text-red-400">{error}</div>;
  if (!patch) return <div className="p-4 text-sm text-zinc-500">No changes.</div>;

  return (
    <div className="h-full overflow-y-auto bg-zinc-950 font-mono text-xs leading-relaxed">
      {rows.map((row, i) => (
        <div key={`${row.kind}-${row.rightLine}-${i}`} className={`flex ${rowClass(row.kind)}`}>
          <span className="w-12 shrink-0 select-none pr-2 text-right text-zinc-600">
            {row.rightLine ?? ""}
          </span>
          <span className="whitespace-pre">{row.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
