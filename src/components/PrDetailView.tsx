import { useEffect, useState } from "react";
import { openExternal } from "../lib/url";
import {
  ghPrDetail,
  ghPrFiles,
  type CheckItem,
  type PrDetail,
  type PrFile,
  type PrSummary,
  type ReviewThread,
} from "../lib/github";
import Markdown from "./Markdown";

function checkColor(check: CheckItem): string {
  if (check.status !== "COMPLETED") return "text-amber-400";
  const conclusion = (check.conclusion ?? "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "text-emerald-400";
  return "text-red-400";
}

function checkGlyph(check: CheckItem): string {
  if (check.status !== "COMPLETED") return "○";
  const conclusion = (check.conclusion ?? "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "✓";
  return "✕";
}

function ChecksSection({ checks }: { checks: CheckItem[] }) {
  if (checks.length === 0) {
    return <p className="text-sm text-zinc-600">No checks reported.</p>;
  }
  return (
    <ul className="space-y-1">
      {checks.map((check, i) => (
        <li key={`${check.name}-${i}`} className="flex items-center gap-2 text-sm">
          <span className={checkColor(check)}>{checkGlyph(check)}</span>
          {check.url ? (
            <button
              onClick={() => openExternal(check.url)}
              className="text-left text-zinc-300 hover:underline"
            >
              {check.name}
            </button>
          ) : (
            <span className="text-zinc-300">{check.name}</span>
          )}
          <span className="text-xs text-zinc-600">
            {check.conclusion?.toLowerCase() ?? check.status.toLowerCase()}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ThreadsSection({ threads }: { threads: ReviewThread[] }) {
  if (threads.length === 0) {
    return <p className="text-sm text-zinc-600">No review comments.</p>;
  }
  return (
    <div className="space-y-3">
      {threads.map((t, i) => (
        <div
          key={i}
          className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
        >
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="font-mono text-zinc-400">
              {t.path ?? "(general)"}
              {t.line != null ? `:${t.line}` : ""}
            </span>
            <span
              className={
                t.isResolved ? "text-emerald-500" : "text-amber-500"
              }
            >
              {t.isResolved ? "resolved" : "open"}
            </span>
          </div>
          <div className="space-y-2">
            {t.comments.map((cm, j) => (
              <div key={j}>
                <div className="text-xs font-medium text-zinc-400">
                  {cm.author}
                </div>
                <Markdown>{cm.body}</Markdown>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

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

function FileDiff({ file }: { file: PrFile }) {
  return (
    <details className="overflow-hidden rounded-lg border border-zinc-800" open>
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

/** Full in-app PR review: description, checks, review threads, and file diffs. */
export default function PrDetailView({
  pr,
  onBack,
}: {
  pr: PrSummary;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [files, setFiles] = useState<PrFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setFiles(null);
    setError(null);
    Promise.all([
      ghPrDetail(pr.owner, pr.repo, pr.number),
      ghPrFiles(pr.owner, pr.repo, pr.number),
    ])
      .then(([d, f]) => {
        if (!active) return;
        setDetail(d);
        setFiles(f);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, [pr.owner, pr.repo, pr.number]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
        >
          ← Back
        </button>
        <button
          onClick={() => openExternal(pr.url)}
          className="text-sm text-sky-400 hover:underline"
        >
          Open on GitHub
        </button>
      </div>

      <header>
        <h2 className="text-lg font-semibold text-zinc-100">
          {pr.title}
          <span className="ml-2 font-normal text-zinc-500">#{pr.number}</span>
        </h2>
        <div className="mt-1 text-xs text-zinc-500">
          {pr.owner}/{pr.repo} · {detail?.author ?? pr.author}
          {detail && (
            <>
              {" · "}
              <span className="font-mono">
                {detail.baseRef} ← {detail.headRef}
              </span>
              {" · "}
              <span className="text-emerald-400">+{detail.additions}</span>{" "}
              <span className="text-red-400">−{detail.deletions}</span>
            </>
          )}
        </div>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {!detail && !error && <p className="text-sm text-zinc-500">Loading…</p>}

      {detail && (
        <>
          <section>
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
              Description
            </h3>
            {detail.body.trim() ? (
              <Markdown>{detail.body}</Markdown>
            ) : (
              <p className="text-sm text-zinc-600">No description.</p>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
              Checks
            </h3>
            <ChecksSection checks={detail.checks} />
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
              Review threads
            </h3>
            <ThreadsSection threads={detail.reviewThreads} />
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
              Files {files ? `(${files.length})` : ""}
            </h3>
            {files === null ? (
              <p className="text-sm text-zinc-500">Loading diff…</p>
            ) : files.length === 0 ? (
              <p className="text-sm text-zinc-600">No file changes.</p>
            ) : (
              <div className="space-y-2">
                {files.map((f) => (
                  <FileDiff key={f.filename} file={f} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
