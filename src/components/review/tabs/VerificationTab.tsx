import { useEffect, useMemo, useState } from "react";
import { cancelAgentRun } from "../../../lib/agentRuns";
import { postPrComment } from "../../../lib/pr/api";
import { prDetailKey } from "../../../lib/pr/cache";
import {
  type RunChoice,
  VERIFICATION_EFFORTS,
  VERIFICATION_MODEL_LABELS,
  VERIFICATION_MODELS,
  type VerificationEffort,
  type VerificationModel,
} from "../../../lib/pr/models";
import { refKey } from "../../../lib/pr/ref";
import type { PrRef, SeenCommits } from "../../../lib/pr/types";
import { invalidate } from "../../../lib/resourceCache";
import type { MutationRun, MutationTestingState } from "../../../lib/reviewWorkspaces/mutation";
import { invalidateLastReview } from "../../../lib/reviewWorkspaces/sinceReview";
import {
  type ChecklistItem,
  DEFAULT_SECTIONS,
  type EvidenceItem,
  type EvidenceSeverity,
  findingCommentBody,
  MAX_NAMED_TICKETS,
  type ReportSection,
  startVerification,
  type VerificationReport,
} from "../../../lib/reviewWorkspaces/verification";
import { openExternal } from "../../../lib/url";
import { createReviewComment } from "../../../lib/workspaceReview";
import { findWorkspaceForPr, type WorkspaceForPr } from "../../../lib/workspaces";
import { Loader } from "../../ai-elements/loader";
import LoadingIndicator from "../../LoadingIndicator";
import DecisionPanel from "./DecisionPanel";
import {
  reportOf,
  useMutationTesting,
  useReviewChangedFiles,
  useReviewTree,
  useReviewViewed,
  useVerificationChecklist,
  useVerificationEvidence,
  useVerificationUpstack,
  verificationKey,
} from "./reviewData";
import { FileNotices, fileNotices } from "./SizeNotices";
import type { TabContext } from "./types";
import VerificationReportView, {
  type FindingPoster,
  Location,
  type OpenLocation,
} from "./VerificationReportView";

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

const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

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
    case "changeMap": {
      const { changeMap } = report;
      if (!changeMap) return null;
      // No themes but changed files means the map failed, which isn't a clean result.
      if (changeMap.themes.length === 0 && changeMap.unmapped.length > 0) {
        return { text: "Not mapped", tone: "warn" };
      }
      const outliers = changeMap.themes.filter((t) => t.cohesion === "outlier").length;
      const themes = plural(changeMap.themes.length, "theme", "themes");
      return outliers > 0
        ? { text: `${themes}, ${plural(outliers, "outlier", "outliers")}`, tone: "warn" }
        : { text: themes, tone: "muted" };
    }
    case "claims": {
      const { claims } = report;
      if (!claims) return null;
      const { items, gaps } = claims;
      const verified = items.filter((c) => c.status === "verified").length;
      const anyUnmet = items.some((c) => c.status === "missing" || c.status === "contradicted");
      const needsAttention = items.some((c) => c.status === "partial") || gaps.length > 0;
      const tone: Tone = anyUnmet ? "bad" : needsAttention ? "warn" : "good";
      if (items.length > 0) return { text: `${verified} of ${items.length} verified`, tone };
      if (gaps.length > 0) return { text: plural(gaps.length, "gap", "gaps"), tone };
      return { text: "No claims", tone: "muted" };
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

/** How often the checklist is re-read while a check runs. */
const POLL_MS = 3000;

const usd = (n: number) => `$${n.toFixed(2)}`;

/** One section on the checklist: whether it has run, what its newest result says, and a button to run it. */
function ChecklistRow({
  item,
  report,
  picked,
  onToggle,
  onRun,
  onCancel,
  canRun,
  starting,
}: {
  item: ChecklistItem;
  report: VerificationReport | null;
  picked: boolean;
  onToggle: () => void;
  onRun: () => void;
  onCancel: (runId: string) => Promise<void>;
  canRun: boolean;
  starting: boolean;
}) {
  const { latest, result } = item;
  // A run another Yarvis instance is doing can't be cancelled from here.
  const running = latest?.status === "running";
  const runningHere = running && latest.live;
  const [actionError, setActionError] = useState<string | null>(null);
  const verdict = report && result ? resultVerdict(item.section, report) : null;
  const cost = result?.costUsd ?? latest?.costUsd ?? null;

  const cancel = async () => {
    if (!latest) return;
    setActionError(null);
    try {
      await onCancel(latest.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  let state: React.ReactNode;
  if (runningHere) {
    state = (
      <span className="flex items-center gap-1.5 text-xs text-zinc-400">
        <Loader />
        Running
      </span>
    );
  } else if (running) {
    state = <span className="text-xs text-zinc-400">Running in another Yarvis instance</span>;
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
          <span className="text-[11px] text-amber-300">
            older head ({shortSha(result.headSha)})
          </span>
        )}
        {cost !== null && <span className="text-[11px] text-zinc-500">{usd(cost)}</span>}
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
        disabled={running}
      />
      <span className="shrink-0 text-zinc-200" title={item.description}>
        {item.label}
      </span>
      <span className="min-w-0 flex-1">{state}</span>
      {actionError && <span className="text-xs text-red-400">{actionError}</span>}
      {runningHere ? (
        <button
          type="button"
          onClick={() => void cancel()}
          className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
      ) : (
        !running && (
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

type MutationVerdict = NonNullable<MutationRun["summary"]>["verdict"];

const MUTATION_VERDICT: Record<MutationVerdict, { label: string; tone: Tone }> = {
  strong: { label: "Strong", tone: "good" },
  mixed: { label: "Mixed", tone: "warn" },
  weak: { label: "Weak", tone: "bad" },
  inconclusive: { label: "Inconclusive", tone: "muted" },
};

/** What the PR's latest mutation-testing pass says, for the checklist. */
function mutationChip(run: MutationRun): { text: string; tone: Tone } | null {
  if (run.status === "failed") return { text: "Last pass failed", tone: "bad" };
  if (run.status === "cancelled") return { text: "Last pass cancelled", tone: "muted" };
  const summary = run.summary;
  if (!summary) return null;
  const { label, tone } = MUTATION_VERDICT[summary.verdict];
  const killed = summary.valid > 0 ? `: ${summary.killed} of ${summary.valid} mutants caught` : "";
  return { text: `${label}${killed}`, tone };
}

/**
 * Mutation testing on the checklist. It runs the PR's own tests, so it starts
 * from its tab, where the reviewer agrees to that; this row says where it
 * stands and opens it.
 */
function MutationRow({
  state,
  error,
  onOpenTab,
}: {
  state: MutationTestingState | null;
  error: string | null;
  onOpenTab: () => void;
}) {
  const run = state?.run ?? null;
  const chip = run && run.status !== "running" ? mutationChip(run) : null;
  return (
    <li className="flex items-center gap-2 py-1 text-sm">
      {/* Lines the label up with the checkbox rows. */}
      <span className="w-[13px] shrink-0" aria-hidden="true" />
      <span
        className="shrink-0 text-zinc-200"
        title="Small deliberate bugs in the changed code, run against the PR's tests, to see whether the tests notice."
      >
        Mutation testing
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {run?.status === "running" && (
          <span className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Loader />
            Running ({run.phase})
          </span>
        )}
        {chip && <Chip {...chip} />}
        {run && !run.isCurrentHead && (
          <span className="text-[11px] text-amber-300">older head ({shortSha(run.headSha)})</span>
        )}
        {!run && !error && (
          <span className="text-xs text-zinc-500">
            Not run{state?.blocked ? `: ${state.blocked.reason}` : ""}
          </span>
        )}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </span>
      <button
        type="button"
        onClick={onOpenTab}
        className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        Open
      </button>
    </li>
  );
}

const SEVERITY_CLASS: Record<EvidenceSeverity, string> = {
  high: "text-red-300",
  medium: "text-amber-300",
  low: "text-zinc-400",
  info: "text-zinc-500",
};

/**
 * What another tool already said, beside the checks Yarvis runs: CI checks,
 * code scanning alerts or bot comments. Nothing to run, so no checkbox; the
 * entries open on demand. Their text was written by the tool, so it is shown
 * as plain text.
 */
function EvidenceRow({ item, onOpen }: { item: EvidenceItem; onOpen: OpenLocation }) {
  const [expanded, setExpanded] = useState(false);
  const totalEntries = item.entries.length + item.hiddenEntries;
  return (
    <li className="py-1 text-sm">
      <div className="flex items-center gap-2">
        {/* Lines the label up with the checkbox rows. */}
        <span className="w-[13px] shrink-0" aria-hidden="true" />
        <span className="shrink-0 text-zinc-200" title={item.description}>
          {item.label}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <Chip text={item.summary} tone={item.tone} />
          <span className="text-[11px] text-zinc-500">reported on the PR</span>
        </span>
        {totalEntries > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {expanded ? "Hide" : `Show ${totalEntries}`}
          </button>
        )}
      </div>
      {item.note && <p className="ml-5 text-[11px] text-zinc-500">{item.note}</p>}
      {expanded && (
        <ul className="mt-1 ml-5 space-y-1.5">
          {item.entries.map((entry, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id and never reorder while shown
            <li key={i} className="text-xs">
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span className={`uppercase text-[10px] ${SEVERITY_CLASS[entry.severity]}`}>
                  {entry.severity}
                </span>
                {/* Check names already lead their titles; a scanner's name doesn't. */}
                {!entry.title.startsWith(entry.source) && (
                  <span className="text-[11px] text-zinc-500">{entry.source}</span>
                )}
                <span className="text-zinc-200">{entry.title}</span>
                {entry.path && (
                  <Location path={entry.path} line={entry.line ?? undefined} onOpen={onOpen} />
                )}
                {entry.url && (
                  <button
                    type="button"
                    onClick={() => openExternal(entry.url)}
                    className="text-[11px] text-sky-400 hover:text-sky-300"
                  >
                    Open
                  </button>
                )}
              </div>
              {entry.detail && <p className="text-zinc-400">{entry.detail}</p>}
            </li>
          ))}
          {item.hiddenEntries > 0 && (
            <li className="text-[11px] text-zinc-500">
              {item.hiddenEntries} more not shown; see the PR.
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** Sections worth running next: the defaults with nothing for the PR's head, and nothing going. */
function suggestedSections(items: ChecklistItem[]): ReportSection[] {
  return items
    .filter(
      (i) =>
        DEFAULT_SECTIONS.includes(i.section) &&
        !i.result?.current &&
        i.latest?.status !== "running",
    )
    .map((i) => i.section);
}

const NO_ITEMS: ChecklistItem[] = [];

/**
 * The verification checklist: every section of the report, grouped by theme,
 * each run on its own when the reviewer chooses, with the report its newest
 * results make below. Every file and line in the report opens the diff there.
 *
 * While a check runs, the checklist is re-read every few seconds rather than
 * each run's event stream followed: one long stream per check would take up
 * the webview's few connections to the sidecar, and every other request
 * would wait behind them.
 */
export default function VerificationTab({ ctx }: { ctx: TabContext }) {
  const { workspaceId, pr } = ctx;
  const checklist = useVerificationChecklist(workspaceId, pr.id);
  const items = checklist.data?.items ?? NO_ITEMS;
  const [pickedSections, setPickedSections] = useState<ReportSection[] | null>(null);
  const picked = pickedSections ?? suggestedSections(items);
  const anyRunning = items.some((i) => i.latest?.status === "running");
  const { refresh } = checklist;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning, refresh]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Empty means each check runs on its own model and effort from Settings.
  const [runChoice, setRunChoice] = useState<RunChoice>({});
  // Tickets the reviewer names for the change map and claims, beside the ones
  // the PR links. Until they type, the last run's are offered again.
  const [typedTickets, setTypedTickets] = useState<string | null>(null);
  const ticketText = typedTickets ?? checklist.data?.namedTickets.join(", ") ?? "";
  const namedTickets = ticketText
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, MAX_NAMED_TICKETS);

  const evidence = useVerificationEvidence(workspaceId, pr.id);
  const mutation = useMutationTesting(workspaceId, pr.id);
  const upstackRead = useVerificationUpstack(workspaceId, pr.id);
  // Their ranges are against the head they were read at, which must be this one.
  const upstack =
    upstackRead.data && upstackRead.data.headSha === checklist.data?.headSha
      ? upstackRead.data
      : null;
  const mutationRunning = mutation.data?.run?.status === "running";
  const refreshMutation = mutation.refresh;
  useEffect(() => {
    if (!mutationRunning) return;
    const timer = setInterval(() => void refreshMutation(), POLL_MS);
    return () => clearInterval(timer);
  }, [mutationRunning, refreshMutation]);
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
      const { runs, failed } = await startVerification(
        workspaceId,
        pr.id,
        sections,
        namedTickets,
        runChoice,
      );
      // Untick only what started, so a check that failed to start stays picked
      // for another try. With nothing left ticked by hand, go back to the
      // suggestions, which follow the PR to its next head.
      const started = runs.map((r) => r.section);
      setPickedSections((prev) => {
        const left = prev?.filter((s) => !started.includes(s)) ?? [];
        return left.length > 0 ? left : null;
      });
      if (failed.length > 0) {
        const labels = failed.map((f) => items.find((i) => i.section === f.section)?.label);
        setActionError(`Couldn't start ${labels.join(", ")}: ${failed[0]?.error}`);
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
      // Even after a failure some checks may have started.
      invalidate(verificationKey(pr.id));
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
          <span className="ml-auto flex items-center gap-2">
            <select
              aria-label="Model for the checks you run"
              title="Run the checks you start on one model instead of each check's own, set in Settings"
              value={runChoice.model ?? ""}
              onChange={(e) =>
                setRunChoice((prev) => ({
                  ...prev,
                  model: (e.target.value || undefined) as VerificationModel | undefined,
                }))
              }
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-xs text-zinc-300"
            >
              <option value="">Each check's model</option>
              {VERIFICATION_MODELS.map((m) => (
                <option key={m} value={m}>
                  {VERIFICATION_MODEL_LABELS[m]}
                </option>
              ))}
            </select>
            <select
              aria-label="Effort for the checks you run"
              title="Run the checks you start at one effort instead of each check's own, set in Settings"
              value={runChoice.effort ?? ""}
              onChange={(e) =>
                setRunChoice((prev) => ({
                  ...prev,
                  effort: (e.target.value || undefined) as VerificationEffort | undefined,
                }))
              }
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-xs text-zinc-300"
            >
              <option value="">Each check's effort</option>
              {VERIFICATION_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort} effort
                </option>
              ))}
            </select>
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

        <DecisionPanel
          prRef={ctx.prRef}
          seen={{ headSha: ctx.pr.headSha, mergeBaseSha: ctx.pr.mergeBaseSha }}
          report={report}
          evidence={
            // CI on another commit says nothing about this one.
            evidence.data && evidence.data.headSha === checklist.data?.headSha
              ? evidence.data.items
              : null
          }
          items={items}
          mutation={mutation.data?.run ?? null}
          upstack={upstack}
          currentSections={currentSections}
          onOpen={open}
        />

        <p className="text-xs text-zinc-500">
          Each check is an agent that reads every changed file's diff. Run the ones you want; each
          runs on its own, and the report below shows each check's newest result. Beside them is
          what CI, code scanners and bots already reported on the PR.
        </p>

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          {evidence.loading && <span>Reading CI checks and scanner results…</span>}
          {evidence.data &&
            checklist.data?.headSha &&
            evidence.data.headSha !== checklist.data.headSha && (
              <span className="text-amber-300">
                CI results are for {shortSha(evidence.data.headSha)}; the checkout is at{" "}
                {shortSha(checklist.data.headSha)}.
              </span>
            )}
          {evidence.error && (
            <span className="text-red-400">Couldn't read CI results: {evidence.error}</span>
          )}
          {!evidence.loading && (
            <button
              type="button"
              onClick={() => void evidence.refresh()}
              disabled={evidence.refreshing}
              className="ml-auto text-sky-400 hover:text-sky-300 disabled:opacity-50"
            >
              {evidence.refreshing ? "Re-reading CI results…" : "Re-read CI results"}
            </button>
          )}
        </div>

        {(checklist.data?.themes ?? []).map((theme) => {
          const rows = items.filter((i) => i.theme === theme.id);
          const evidenceRows = evidence.data?.items.filter((i) => i.theme === theme.id) ?? [];
          if (rows.length === 0 && evidenceRows.length === 0) return null;
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
                    report={report}
                    picked={picked.includes(item.section)}
                    onToggle={() => toggle(item.section)}
                    onRun={() => void run([item.section])}
                    onCancel={async (runId) => {
                      await cancelAgentRun(runId);
                      await refresh();
                    }}
                    canRun={!notReady}
                    starting={starting}
                  />
                ))}
                {theme.id === "correctness" && (
                  <MutationRow
                    state={mutation.data ?? null}
                    error={mutation.error}
                    onOpenTab={() => ctx.openTab({ kind: "mutation", prId: pr.id })}
                  />
                )}
                {evidenceRows.map((item) => (
                  <EvidenceRow key={item.id} item={item} onOpen={open} />
                ))}
              </ul>
            </section>
          );
        })}

        <label className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <span title="Issues the PR closes, its linked work items, and Jira keys in its title or branch are read anyway.">
            More tickets for the change map and claims
          </span>
          <input
            type="text"
            value={ticketText}
            onChange={(e) => setTypedTickets(e.target.value)}
            placeholder="ABC-123, #45 or a ticket link"
            className="min-w-[16rem] flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600"
          />
        </label>

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
            upstack={upstack}
          />
        )}
      </div>
    </div>
  );
}
