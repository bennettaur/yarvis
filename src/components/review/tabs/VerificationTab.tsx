import { useEffect, useMemo, useState } from "react";
import { cancelAgentRun, streamAgentRun } from "../../../lib/agentRuns";
import { postPrComment } from "../../../lib/pr/api";
import { prDetailKey } from "../../../lib/pr/cache";
import { refKey } from "../../../lib/pr/ref";
import type { PrRef, SeenCommits } from "../../../lib/pr/types";
import { invalidate } from "../../../lib/resourceCache";
import { invalidateLastReview } from "../../../lib/reviewWorkspaces/sinceReview";
import {
  type ChecklistItem,
  DEFAULT_SECTIONS,
  findingCommentBody,
  type ReportSection,
  startVerification,
  type VerificationReport,
} from "../../../lib/reviewWorkspaces/verification";
import { createReviewComment } from "../../../lib/workspaceReview";
import { findWorkspaceForPr, type WorkspaceForPr } from "../../../lib/workspaces";
import { Loader } from "../../ai-elements/loader";
import LoadingIndicator from "../../LoadingIndicator";
import {
  reportOf,
  useReviewChangedFiles,
  useReviewTree,
  useReviewViewed,
  useVerificationChecklist,
  verificationKey,
} from "./reviewData";
import { FileNotices, fileNotices } from "./SizeNotices";
import type { TabContext } from "./types";
import VerificationReportView, {
  type FindingPoster,
  type OpenLocation,
} from "./VerificationReportView";
import { initialProgress, type RunProgress, reduceProgress } from "./verificationProgress";

/** The Yarvis workspace the PR was raised from, if any: where its findings can go as local comments. */
function useLinkedWorkspace(prRef: PrRef): WorkspaceForPr | null {
  const [workspace, setWorkspace] = useState<WorkspaceForPr | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on ref identity, not the unstable ref object
  useEffect(() => {
    let live = true;
    setWorkspace(null);
    findWorkspaceForPr(prRef)
      .then((w) => live && setWorkspace(w))
      .catch(() => live && setWorkspace(null));
    return () => {
      live = false;
    };
  }, [refKey(prRef)]);
  return workspace;
}

/**
 * Sends a finding the reviewer chose: to the PR as a line comment, or into the
 * linked workspace's review comments, marked as a report finding so the agent
 * there reads it fenced.
 */
export function findingPoster(
  prRef: PrRef,
  seen: SeenCommits,
  linked: WorkspaceForPr | null,
): FindingPoster {
  return {
    toPr: async (f, section) => {
      const { placement } = await postPrComment(
        prRef,
        { path: f.path, line: f.line, body: findingCommentBody(f, section) },
        seen,
      );
      // So the PR's diff tabs show the new thread, and the review mark the post recorded.
      invalidate(prDetailKey(prRef));
      invalidateLastReview(prRef);
      return placement;
    },
    ...(linked && {
      toWorkspace: {
        name: linked.name,
        add: async (f, section) => {
          await createReviewComment(linked.id, {
            workspaceRepoId: linked.workspaceRepoId,
            path: f.path,
            startLine: f.line,
            endLine: f.line,
            body: findingCommentBody(f, section),
            source: "verification",
          });
        },
      },
    }),
  };
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

type Tone = "good" | "warn" | "bad" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  good: "border-emerald-800 text-emerald-300",
  warn: "border-amber-800 text-amber-300",
  bad: "border-red-800 text-red-300",
  muted: "border-zinc-700 text-zinc-400",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a section's result says, in a few words, for its checklist row. */
export function resultVerdict(
  section: ReportSection,
  report: VerificationReport,
): { text: string; tone: Tone } | null {
  switch (section) {
    case "summary": {
      if (report.summary === undefined) return null;
      const n = report.mustRead.length;
      return {
        text: n ? plural(n, "must-read file", "must-read files") : "Summary",
        tone: "muted",
      };
    }
    case "risk": {
      const { risk } = report;
      if (!risk) return null;
      const tone: Tone = risk.level === "high" ? "bad" : risk.level === "medium" ? "warn" : "good";
      return { text: risk.impact ? `Impact ${risk.impact.band}/5` : `${risk.level} risk`, tone };
    }
    case "approach": {
      const { approach } = report;
      if (!approach) return null;
      if (approach.rating === "no-simpler") return { text: "No simpler way", tone: "good" };
      if (approach.rating === "unrated") return { text: "Not rated", tone: "muted" };
      return {
        text: approach.rating === "much-simpler" ? "Much simpler way" : "Simpler way",
        tone: approach.rating === "much-simpler" ? "bad" : "warn",
      };
    }
    case "flow":
      if (!report.flow) return null;
      return report.flow.mermaid
        ? { text: "Drawn", tone: "muted" }
        : { text: "Not drawn", tone: "muted" };
    default: {
      const check = report[section];
      if (!check) return null;
      if (check.findings.length === 0) return { text: "Pass", tone: "good" };
      const high = check.findings.some((f) => f.severity === "high");
      return {
        text: plural(check.findings.length, "finding", "findings"),
        tone: high ? "bad" : "warn",
      };
    }
  }
}

function Chip({ text, tone }: { text: string; tone: Tone }) {
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${TONE_CLASS[tone]}`}>
      {text}
    </span>
  );
}

/**
 * Follows one run's events into its progress, from the start (the stream
 * replays what already happened) to its `done`. When it ends the checklist is
 * re-read, which is where the finished result comes from.
 */
export function useVerificationRun(
  prId: string,
  runId: string | null,
  section: ReportSection,
): RunProgress | null {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  useEffect(() => {
    const initial = () => initialProgress([section]);
    setProgress(runId ? initial() : null);
    if (!runId) return;
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of streamAgentRun(runId, abort.signal)) {
          setProgress((p) => reduceProgress(p ?? initial(), event));
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        setProgress((p) => ({
          ...(p ?? initial()),
          error: `Lost track of the run: ${e instanceof Error ? e.message : String(e)}`,
        }));
      }
      if (!abort.signal.aborted) invalidate(verificationKey(prId));
    })();
    return () => abort.abort();
  }, [prId, runId, section]);
  return progress;
}

/**
 * One section on the checklist: whether it has run, what its newest result
 * says, and a button to run it. A run going in this window is followed live.
 */
function ChecklistRow({
  item,
  prId,
  report,
  startedRunId,
  picked,
  onToggle,
  onRun,
  canRun,
  starting,
}: {
  item: ChecklistItem;
  prId: string;
  report: VerificationReport | null;
  /** A run this window just started, before the checklist is re-read. */
  startedRunId: string | null;
  picked: boolean;
  onToggle: () => void;
  onRun: () => void;
  canRun: boolean;
  starting: boolean;
}) {
  const { latest, result } = item;
  const runningHere = latest?.status === "running" && latest.live ? latest.id : null;
  const followId = startedRunId ?? runningHere;
  const progress = useVerificationRun(prId, followId, item.section);
  const running = followId !== null && progress !== null && progress.finished === null;
  const runningElsewhere = !running && latest?.status === "running" && !latest.live;
  const [actionError, setActionError] = useState<string | null>(null);
  const verdict = report && result ? resultVerdict(item.section, report) : null;
  const activity =
    progress?.checks.find((c) => c.state === "running")?.activity ?? progress?.activity;

  const cancel = async () => {
    if (!followId) return;
    setActionError(null);
    try {
      await cancelAgentRun(followId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  let state: React.ReactNode;
  if (running) {
    state = (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-400">
        <Loader />
        <span className="shrink-0">Running</span>
        {activity && <span className="min-w-0 truncate font-mono text-[11px]">{activity}</span>}
      </span>
    );
  } else if (runningElsewhere) {
    state = <span className="text-xs text-zinc-400">Running in another window</span>;
  } else {
    state = (
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        {latest?.status === "failed" && (
          <span title={latest.error ?? undefined}>
            <Chip text="Last run failed" tone="bad" />
          </span>
        )}
        {latest?.status === "cancelled" && <Chip text="Last run cancelled" tone="muted" />}
        {verdict && <Chip {...verdict} />}
        {result && !result.current && (
          <span className="text-[11px] text-amber-300">older head ({short(result.headSha)})</span>
        )}
        {!latest && <span className="text-xs text-zinc-500">Not run</span>}
      </span>
    );
  }

  return (
    <li className="flex items-center gap-2 py-1 text-sm">
      <input
        type="checkbox"
        aria-label={`Pick ${item.label}`}
        checked={picked}
        onChange={onToggle}
        disabled={running || runningElsewhere}
      />
      <span className="shrink-0 text-zinc-200" title={item.description}>
        {item.label}
      </span>
      <span className="min-w-0 flex-1">{state}</span>
      {actionError && <span className="text-xs text-red-400">{actionError}</span>}
      {running ? (
        <button
          type="button"
          onClick={() => void cancel()}
          className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
      ) : (
        !runningElsewhere && (
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun || starting}
            className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {latest ? "Re-run" : "Run"}
          </button>
        )
      )}
    </li>
  );
}

/** Sections worth running next: the defaults with nothing for the PR's head, and nothing going. */
function suggested(items: ChecklistItem[]): ReportSection[] {
  return items
    .filter(
      (i) =>
        DEFAULT_SECTIONS.includes(i.section) &&
        !i.result?.current &&
        i.latest?.status !== "running",
    )
    .map((i) => i.section);
}

/**
 * The verification checklist: every section of the report, grouped by theme,
 * each run on its own when the reviewer chooses, with the report its newest
 * results make below. Every file and line in the report opens the diff there.
 */
export default function VerificationTab({ ctx }: { ctx: TabContext }) {
  const { workspaceId, pr } = ctx;
  const checklist = useVerificationChecklist(workspaceId, pr.id);
  const items = checklist.data?.items ?? [];
  // Runs this window started, by section, followed before the checklist is re-read.
  const [started, setStarted] = useState<Partial<Record<ReportSection, string>>>({});
  const [pickedSections, setPickedSections] = useState<ReportSection[] | null>(null);
  const picked = pickedSections ?? suggested(items);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const report = reportOf(checklist.data);
  const size = checklist.data?.size ?? null;
  const viewed = useReviewViewed(ctx.prRef);
  const linked = useLinkedWorkspace(ctx.prRef);
  const poster = useMemo(
    () =>
      findingPoster(
        ctx.prRef,
        { headSha: ctx.pr.headSha, mergeBaseSha: ctx.pr.mergeBaseSha },
        linked,
      ),
    [ctx.prRef, ctx.pr.headSha, ctx.pr.mergeBaseSha, linked],
  );
  // An older head's line numbers may point at different code now, so only a
  // section whose result is for the current head can post.
  const currentSections = useMemo(
    () => new Set(items.filter((i) => i.result?.current).map((i) => i.section)),
    [items],
  );

  const run = async (sections: ReportSection[]) => {
    if (sections.length === 0) return;
    setStarting(true);
    setActionError(null);
    try {
      const { runs } = await startVerification(workspaceId, pr.id, sections);
      setStarted((prev) => ({
        ...prev,
        ...Object.fromEntries(runs.filter((r) => !r.existing).map((r) => [r.section, r.runId])),
      }));
      setPickedSections((prev) => (prev ?? picked).filter((s) => !sections.includes(s)));
      invalidate(verificationKey(pr.id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const toggle = (section: ReportSection) =>
    setPickedSections(
      picked.includes(section) ? picked.filter((s) => s !== section) : [...picked, section],
    );

  // The report is model-written, so only a path the PR actually has is a link.
  const changed = useReviewChangedFiles(workspaceId, pr);
  const tree = useReviewTree(workspaceId, pr);
  const known = useMemo(
    () => new Set([...(changed.data?.files.map((f) => f.path) ?? []), ...(tree.data?.paths ?? [])]),
    [changed.data, tree.data],
  );
  const open: OpenLocation = {
    open: (path, line) =>
      ctx.openTab({ kind: "diff", prId: pr.id, path, ...(line ? { revealLine: line } : {}) }),
    canOpen: (path) => known.has(path),
  };

  const notReady = pr.status !== "ready" || pr.worktreeStatus !== "ready";

  if (checklist.loading) {
    return (
      <div className="p-4">
        <LoadingIndicator label="Loading the verification checklist…" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* 80% so diagrams grow with the window; never narrower than 48rem unless the pane is. */}
      <div className="mx-auto w-4/5 min-w-[min(100%,48rem)] space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-200">Verification</h2>
          <span className="ml-auto">
            <button
              type="button"
              onClick={() => void run(picked)}
              disabled={starting || notReady || picked.length === 0}
              title={
                notReady
                  ? "Waiting for the checkout"
                  : picked.length === 0
                    ? "Pick at least one check"
                    : undefined
              }
              className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50"
            >
              {starting ? "Starting…" : `Run picked (${picked.length})`}
            </button>
          </span>
        </div>

        <p className="text-xs text-zinc-500">
          Each check is an agent that reads every changed file's diff. Run the ones you want; each
          runs on its own, and the report below shows each check's newest result.
        </p>

        {(checklist.data?.themes ?? []).map((theme) => {
          const rows = items.filter((i) => i.theme === theme.id);
          if (rows.length === 0) return null;
          return (
            <section key={theme.id} className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {theme.label}
              </h3>
              <ul className="divide-y divide-zinc-800/60">
                {rows.map((item) => (
                  <ChecklistRow
                    key={item.section}
                    item={item}
                    prId={pr.id}
                    report={report}
                    startedRunId={started[item.section] ?? null}
                    picked={picked.includes(item.section)}
                    onToggle={() => toggle(item.section)}
                    onRun={() => void run([item.section])}
                    canRun={!notReady}
                    starting={starting}
                  />
                ))}
              </ul>
            </section>
          );
        })}

        {size && (
          // Say up front what the checks won't read whole.
          <div className="text-xs text-zinc-400" data-testid="file-notices">
            <FileNotices notices={fileNotices(size)} />
          </div>
        )}

        {actionError && (
          <p role="alert" className="text-xs text-red-400">
            {actionError}
          </p>
        )}
        {checklist.error && <p className="text-xs text-red-400">{checklist.error}</p>}

        {report && (
          <VerificationReportView
            report={report}
            onOpen={open}
            viewed={viewed.viewed}
            poster={poster}
            currentSections={currentSections}
          />
        )}
      </div>
    </div>
  );
}
