import { useEffect, useMemo, useState } from "react";
import { type DiffRow, parsePatch } from "../../../lib/pr/diff";
import { invalidate } from "../../../lib/resourceCache";
import {
  chapterRead,
  rowsInRange,
  type StoryChapter,
  storyChapters,
} from "../../../lib/reviewWorkspaces/story";
import {
  startVerification,
  THEME_RISK_LABEL,
  type VerificationReport,
} from "../../../lib/reviewWorkspaces/verification";
import { rowClass } from "../../diff/DiffRow";
import LoadingIndicator from "../../LoadingIndicator";
import { type FileNote, fileNotes } from "./reportHighlights";
import {
  fileDiffKey,
  reportOf,
  useReviewChangedFiles,
  useReviewFileDiff,
  useReviewViewed,
  useVerificationChecklist,
  verificationKey,
} from "./reviewData";
import type { TabContext } from "./types";
import { Location, type OpenLocation } from "./VerificationReportView";

/** How often the story is re-read while its change map is being written. */
const POLL_MS = 3000;
/** Past this many rows a file's part is cut short; the diff tab has the rest. */
const MAX_ROWS = 400;

/** A chapter shows this many files at first, so a big one doesn't read every patch at once. */
const FILES_SHOWN = 5;

const COHESION_LABEL = { core: "Core", supporting: "Supporting", outlier: "Outlier" } as const;

/**
 * One file's part in a chapter: the hunks that touch the theme's lines, with
 * the report's notes on those lines. Read-only; the path opens the full diff,
 * where comments go.
 */
function FilePart({
  ctx,
  file,
  report,
  onOpen,
}: {
  ctx: TabContext;
  file: StoryChapter["files"][number];
  report: VerificationReport | null;
  onOpen: OpenLocation;
}) {
  const diff = useReviewFileDiff(ctx.workspaceId, ctx.pr, file.path);
  const start = file.lines?.start;
  const end = file.lines?.end;
  const rows = useMemo(() => {
    if (!diff.data) return [];
    const range = start !== undefined && end !== undefined ? { start, end } : undefined;
    return rowsInRange(parsePatch(diff.data.patch), range);
  }, [diff.data, start, end]);
  const notes = useMemo(() => {
    const all = fileNotes(report, file.path);
    return start !== undefined && end !== undefined
      ? all.filter((n) => n.line >= start && n.line <= end)
      : all;
  }, [report, file.path, start, end]);
  const shown = useMemo(() => rows.slice(0, MAX_ROWS), [rows]);
  const { notesByLine, elsewhere } = useMemo(() => {
    const lines = new Set(shown.map((r) => r.rightLine));
    const byLine = new Map<number, FileNote[]>();
    const rest: FileNote[] = [];
    for (const n of notes) {
      if (lines.has(n.line)) byLine.set(n.line, [...(byLine.get(n.line) ?? []), n]);
      else rest.push(n);
    }
    return { notesByLine: byLine, elsewhere: rest };
  }, [notes, shown]);
  const noDiff = fileDiffKey(ctx.pr, file.path) === null;

  return (
    <div className="space-y-1">
      <Location
        path={file.path}
        line={start}
        label={file.lines ? `:${file.lines.start}-${file.lines.end}` : ""}
        onOpen={onOpen}
        className="text-xs"
      />
      {noDiff && (
        <p className="text-xs text-zinc-500">The diff shows once the checkout is ready.</p>
      )}
      {diff.loading && <LoadingIndicator label="Reading the diff…" />}
      {diff.error && <p className="text-xs text-red-400">{diff.error}</p>}
      {diff.data?.tooLarge && (
        <p className="text-xs text-zinc-500">Too large to show here; click the path above.</p>
      )}
      {diff.data && !diff.data.tooLarge && rows.length === 0 && (
        <p className="text-xs text-zinc-500">No text changes to show here; click the path above.</p>
      )}
      {shown.length > 0 && (
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full border-collapse font-mono text-[11px] leading-snug">
            <tbody>
              {shown.map((row, i) => (
                <PatchRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and never reorder
                  key={i}
                  row={row}
                  notes={row.rightLine !== null ? notesByLine.get(row.rightLine) : undefined}
                />
              ))}
            </tbody>
          </table>
          {rows.length > MAX_ROWS && (
            <p className="px-2 py-1 text-[11px] text-zinc-500">
              {rows.length - MAX_ROWS} more lines; click the path above for the rest.
            </p>
          )}
        </div>
      )}
      {elsewhere.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {elsewhere.map((n, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two notes can share a source and title
            <li key={i} className="text-amber-200">
              <span className="text-amber-400">
                {n.source} (line {n.line}):{" "}
              </span>
              {n.title}
              {n.detail && <span className="text-amber-200/70"> — {n.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A patch row, and under it any note the report put on that line. The text is the patch's own, shown as plain text. */
function PatchRow({ row, notes }: { row: DiffRow; notes: FileNote[] | undefined }) {
  return (
    <>
      <tr className={rowClass(row.kind)}>
        <td className="w-10 select-none px-1 text-right align-top text-zinc-600">
          {row.leftLine ?? ""}
        </td>
        <td className="w-10 select-none px-1 text-right align-top text-zinc-600">
          {row.rightLine ?? ""}
        </td>
        <td className="whitespace-pre px-2">{row.text}</td>
      </tr>
      {notes?.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two notes can share a source and title
        <tr key={i} className="bg-amber-950/30">
          <td colSpan={2} />
          <td className="px-2 py-0.5 font-sans text-amber-200">
            <span className="text-amber-400">{n.source}: </span>
            {n.title}
            {n.detail && <span className="text-amber-200/70"> — {n.detail}</span>}
          </td>
        </tr>
      ))}
    </>
  );
}

/** A chapter's files, the first few at once and the rest on request. Keyed by chapter, so the count resets. */
function ChapterFiles({
  ctx,
  files,
  report,
  onOpen,
}: {
  ctx: TabContext;
  files: StoryChapter["files"];
  report: VerificationReport | null;
  onOpen: OpenLocation;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  return (
    <>
      {shown.map((f) => (
        <FilePart
          key={`${f.path}:${f.lines?.start}`}
          ctx={ctx}
          file={f}
          report={report}
          onOpen={onOpen}
        />
      ))}
      {shown.length < files.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Show {files.length - shown.length} more files
        </button>
      )}
    </>
  );
}

/**
 * Story mode: the PR read theme by theme, the work that matters first, each
 * chapter's description above the hunks it covers. Beside the guided review,
 * which orders the reading by how the code calls itself; this orders it by
 * what the change is for. The chapters come from the verification report's
 * change map, which the tab offers to write when there is none.
 */
export default function StoryTab({ ctx }: { ctx: TabContext }) {
  const { workspaceId, pr } = ctx;
  const checklist = useVerificationChecklist(workspaceId, pr.id);
  const report = reportOf(checklist.data);
  const map = report?.changeMap ?? null;
  const changeMapItem = checklist.data?.items.find((i) => i.section === "changeMap") ?? null;
  const writing = changeMapItem?.latest?.status === "running";
  const { refresh } = checklist;
  useEffect(() => {
    if (!writing) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [writing, refresh]);

  const viewed = useReviewViewed(ctx.prRef);
  const chapters = useMemo(() => (map ? storyChapters(map) : []), [map]);
  const [chosen, setChosen] = useState<string | null>(null);
  // Until the reader picks one, the story opens at the first chapter not yet read.
  const firstUnread = chapters.find((c) => !chapterRead(c, viewed.viewed)) ?? chapters[0];
  const current = chapters.find((c) => c.key === chosen) ?? firstUnread;
  const currentIndex = current ? chapters.indexOf(current) : -1;
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // The map is model-written, so only a file the PR changes is a link.
  const changed = useReviewChangedFiles(workspaceId, pr);
  const changedPaths = useMemo(
    () => new Set(changed.data?.files.map((f) => f.path) ?? []),
    [changed.data],
  );
  const opener: OpenLocation = {
    open: (path, line) =>
      ctx.openTab({ kind: "diff", prId: pr.id, path, ...(line ? { revealLine: line } : {}) }),
    canOpen: (path) => changedPaths.has(path),
  };

  const writeChangeMap = async () => {
    setStarting(true);
    setError(null);
    try {
      const { failed } = await startVerification(workspaceId, pr.id, ["changeMap"]);
      if (failed[0]) setError(failed[0].error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
      invalidate(verificationKey(pr.id));
    }
  };

  const markReadAndContinue = async () => {
    if (!current) return;
    await viewed.markAllViewed(current.files.map((f) => f.path));
    const next = chapters[currentIndex + 1];
    if (next) setChosen(next.key);
  };

  if (checklist.loading) {
    return (
      <div className="p-4">
        <LoadingIndicator label="Loading the story…" />
      </div>
    );
  }

  const notReady = pr.status !== "ready" || pr.worktreeStatus !== "ready";
  if (!map || chapters.length === 0) {
    return (
      <div className="space-y-3 p-4 text-sm text-zinc-400">
        <p>
          Story mode reads the PR theme by theme, the work that matters first: each chapter says
          what changed and why, above the hunks it covers. The chapters come from the change map,
          which an agent writes.
        </p>
        {writing ? (
          <LoadingIndicator label="Writing the change map…" />
        ) : (
          <button
            type="button"
            onClick={() => void writeChangeMap()}
            disabled={starting || notReady}
            title={notReady ? "Waiting for the checkout" : undefined}
            className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {starting ? "Starting…" : "Write the change map"}
          </button>
        )}
        {(error ?? checklist.error) && (
          <p className="text-xs text-red-400">{error ?? checklist.error}</p>
        )}
      </div>
    );
  }

  const readCount = chapters.filter((c) => chapterRead(c, viewed.viewed)).length;
  return (
    <div className="flex h-full min-h-0">
      <nav className="w-60 shrink-0 space-y-1 overflow-y-auto border-r border-zinc-800 p-3 text-xs">
        <p className="text-zinc-300">{map.intent}</p>
        <p className="text-zinc-500">
          {readCount} of {chapters.length} chapters read
          {changeMapItem?.result &&
            !changeMapItem.result.current &&
            (changeMapItem.result.headSha
              ? ` · written for an older commit (${changeMapItem.result.headSha.slice(0, 7)})`
              : " · written for an older commit")}
          {writing && " · rewriting"}
        </p>
        <ol className="space-y-0.5">
          {chapters.map((c, i) => {
            const read = chapterRead(c, viewed.viewed);
            return (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => setChosen(c.key)}
                  aria-current={c === current ? "step" : undefined}
                  className={`w-full rounded px-1.5 py-1 text-left hover:bg-zinc-800 ${
                    c === current ? "bg-zinc-800 text-zinc-100" : "text-zinc-300"
                  } ${read ? "opacity-60" : ""}`}
                >
                  <span className="text-zinc-500">{i + 1}.</span> {c.title}
                  {c.cohesion === "outlier" && <span className="text-amber-400"> · outlier</span>}
                  {read && <span className="text-emerald-400"> ✓</span>}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {current && (
        <article className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
          <header className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-500">
                Chapter {currentIndex + 1} of {chapters.length}
              </span>
              {current.cohesion && (
                <span className="rounded border border-zinc-700 px-1 py-0.5 text-[10px] uppercase text-zinc-400">
                  {COHESION_LABEL[current.cohesion]}
                </span>
              )}
              {current.risk && (
                <span className="rounded border border-zinc-700 px-1 py-0.5 text-[10px] text-zinc-400">
                  {THEME_RISK_LABEL[current.risk]}
                </span>
              )}
            </div>
            <h3 className="text-base font-semibold text-zinc-100">{current.title}</h3>
            <p className="text-sm text-zinc-300">{current.description}</p>
            {current.question && (
              <p className="text-xs text-amber-200">
                <span className="text-amber-400">Ask the author: </span>
                {current.question}
              </p>
            )}
          </header>
          <ChapterFiles
            key={current.key}
            ctx={ctx}
            files={current.files}
            report={report}
            onOpen={opener}
          />
          <footer className="flex items-center gap-2 border-t border-zinc-800 pt-3">
            <button
              type="button"
              disabled={currentIndex <= 0}
              onClick={() => setChosen(chapters[currentIndex - 1]?.key ?? null)}
              className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void markReadAndContinue()}
              className="rounded bg-sky-700 px-2.5 py-1 text-xs text-white hover:bg-sky-600"
            >
              {currentIndex + 1 < chapters.length ? "Mark read and continue" : "Mark read"}
            </button>
            {viewed.error && <span className="text-xs text-red-400">{viewed.error}</span>}
          </footer>
        </article>
      )}
    </div>
  );
}
