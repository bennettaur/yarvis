import { usePrFiles } from "../../lib/githubCache";
import { type PrFile } from "../../lib/github";
import { prFileAnchorId, type PrRef } from "./shared";

/** Renders one file's unified-diff patch with per-line add/remove coloring. */
function DiffView({ patch }: { patch: string | null }) {
  if (!patch) {
    return (
      <p className="px-3 py-2 text-xs text-zinc-600">
        No textual diff (binary or too large).
      </p>
    );
  }
  return (
    <pre className="overflow-x-auto bg-zinc-950 font-mono text-xs leading-relaxed">
      {patch.split("\n").map((line, i) => {
        let cls = "text-zinc-400";
        if (line.startsWith("@@")) cls = "bg-sky-950/60 text-sky-300";
        else if (line.startsWith("+")) cls = "bg-emerald-950/50 text-emerald-300";
        else if (line.startsWith("-")) cls = "bg-red-950/50 text-red-300";
        return (
          <div key={i} className={`px-3 ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function FileDiff({ file, anchorId }: { file: PrFile; anchorId: string }) {
  return (
    <details
      id={anchorId}
      className="scroll-mt-4 overflow-hidden rounded-lg border border-zinc-800"
      open
    >
      <summary className="cursor-pointer bg-zinc-900 px-3 py-2 text-sm">
        <span className="font-mono text-zinc-200">{file.filename}</span>
        <span className="ml-2 text-xs text-emerald-400">+{file.additions}</span>
        <span className="ml-1 text-xs text-red-400">−{file.deletions}</span>
        {file.status !== "modified" && (
          <span className="ml-2 text-xs text-zinc-500">{file.status}</span>
        )}
      </summary>
      <DiffView patch={file.patch} />
    </details>
  );
}

/** The changed files of a PR rendered as expandable unified diffs. */
export default function PrFileDiffs(ref: PrRef) {
  const { data, error, loading } = usePrFiles(ref.owner, ref.repo, ref.number);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading diff…</p>;
  if (data.length === 0) return <p className="text-sm text-zinc-600">No file changes.</p>;

  return (
    <div className="space-y-2">
      {data.map((f, i) => (
        <FileDiff key={f.filename} file={f} anchorId={prFileAnchorId(ref, i)} />
      ))}
    </div>
  );
}
