import type { AgentRunStatus } from "../agentRuns";
import { ensureOk, sidecarFetch } from "../api";

/**
 * Client for a review PR's verification checklist: starting a run for each
 * picked section, and reading each section's latest run and newest result
 * with the report they make. Following a run live goes through
 * `lib/agentRuns`, like any other headless Claude Code run.
 */

export type Severity = "high" | "medium" | "low";

export interface VerificationFinding {
  title: string;
  detail: string;
  severity: Severity;
  path?: string;
  line?: number;
}

/** One check's verdict; `pass` exactly when it has no findings. */
export interface VerificationCheck {
  status: "pass" | "issues";
  findings: VerificationFinding[];
}

export interface VerificationConcern {
  title: string;
  detail: string;
  path?: string;
  line?: number;
}

export type ChangeKind =
  | "passive"
  | "reorganization"
  | "addition"
  | "removal"
  | "interface"
  | "logic";

export type ImpactBand = 1 | 2 | 3 | 4 | 5;

/** Mirrors a scored change from the sidecar's `verify/impact.ts`. */
export interface VerificationChange {
  title: string;
  kind: ChangeKind;
  reach: "leaf" | "local" | "shared" | "core";
  evidence: "proven" | "partial" | "unproven";
  sensitive: boolean;
  count: number;
  /** What a reviewer should confirm; empty below the attention band. */
  check: string;
  path?: string;
  line?: number;
  band: ImpactBand;
}

/** Mirrors the risk section's `impact`: the score of the agent's classified changes. */
export interface VerificationImpact {
  band: ImpactBand;
  /** The highest band any one change has; below `band` when volume raised it. */
  highestChangeBand: ImpactBand;
  load: number;
  raisedByVolume: number;
  counts: Record<ChangeKind, number>;
  /** Highest band first. */
  changes: VerificationChange[];
}

/** Something in a must-read file that already looks off or unclear. */
export interface VerificationMustReadFlag {
  note: string;
  line?: number;
}

export interface VerificationMustRead {
  path: string;
  reason: string;
  lines?: { start: number; end: number };
  /** Absent on a report from before must-reads carried flags. */
  flags?: VerificationMustReadFlag[];
}

/**
 * Which changed files the run's agents read, counted by the sidecar from the
 * run's Read calls (`reviewWorkspaces/coverage.ts`), not taken from them.
 */
export interface VerificationCoverage {
  /** Files at least one check read in full. */
  examined: number;
  total: number;
  /** Lockfiles and generated, vendored or minified files whose first page was read. */
  skimmed: { path: string; kind: string }[];
  notExamined: { path: string; reason: string }[];
  /** Per check: patches it didn't read itself. */
  laneGaps: { check: string; paths: string[] }[];
}

/** Counting the coverage failed: the report stands, what it read is unknown. */
export interface UnknownCoverage {
  unknown: true;
}

export const coverageKnown = (
  c: VerificationCoverage | UnknownCoverage | undefined,
): c is VerificationCoverage => !!c && !("unknown" in c);

/** A Mermaid flowchart of the flow the change sits in. `mermaid` is empty when there was none to draw. */
export interface VerificationFlow {
  title: string;
  explanation: string;
  mermaid: string;
  /** The agent's diagram was over the size limit, so it was dropped. */
  tooLarge?: boolean;
}

/**
 * Whether the PR as a whole has a materially simpler way to its goal.
 * `alternative` is empty, and there is no location, unless a simpler way was
 * found. `unrated` means the agent failed to answer.
 */
export interface VerificationApproach {
  rating: "no-simpler" | "simpler" | "much-simpler" | "unrated";
  reason: string;
  alternative: string;
  path?: string;
  line?: number;
}

export type ThemeCohesion = "core" | "supporting" | "outlier";

/** One theme of the change: a reason the code changed, and the files it touched for it. */
export interface ChangeTheme {
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  /** How it fits what the PR is for; an outlier isn't needed for it. */
  cohesion: ThemeCohesion;
  /** For an outlier, what to ask the author; empty otherwise. */
  question: string;
  files: { path: string; lines?: { start: number; end: number } }[];
}

/** The change grouped into themes. `unmapped` lists changed files no theme names. */
export interface VerificationChangeMap {
  intent: string;
  themes: ChangeTheme[];
  unmapped: string[];
}

/** Most tickets a reviewer can name for one run; mirrors the sidecar's `MAX_NAMED_TICKETS`. */
export const MAX_NAMED_TICKETS = 5;

export type ClaimStatus = "verified" | "partial" | "missing" | "contradicted" | "unverifiable";

export interface VerificationClaim {
  claim: string;
  /** "title", "description", or a ticket's key. */
  source: string;
  status: ClaimStatus;
  evidence: string;
  path?: string;
  line?: number;
}

/** The PR's claims checked against the code, and what they were checked against. */
export interface VerificationClaims {
  items: VerificationClaim[];
  /** Unfinished work no claim covers. */
  gaps: VerificationFinding[];
  /** The tickets the claims run read; absent on a run that read none. */
  tickets?: { key: string; title: string; url: string }[];
  /** Tickets named but not read, and why. */
  ticketNotes?: string[];
}

/**
 * Mirrors the sidecar's `ChecklistReport` (`reviewWorkspaces/checklist.ts`):
 * each section's newest result. A section with no result is absent; with no
 * summary result, `mustRead` is empty.
 */
export interface VerificationReport {
  summary?: string;
  mustRead: VerificationMustRead[];
  changeMap?: VerificationChangeMap;
  claims?: VerificationClaims;
  risk?: {
    level: "low" | "medium" | "high";
    clientImpact: string;
    mitigations: string[];
    concerns: VerificationConcern[];
    /** Absent on a report from before changes were scored, or one whose agent listed none. */
    impact?: VerificationImpact;
  };
  malice?: VerificationCheck & {
    /** What the sidecar's fixed rules found in the diff, whatever the check decided about each. */
    tripwires?: VerificationTripwire[];
    tripwiresOmitted?: number;
  };
  tests?: VerificationCheck;
  complexity?: VerificationCheck;
  performance?: VerificationCheck;
  comments?: VerificationCheck;
  observability?: VerificationCheck;
  quality?: VerificationCheck;
  approach?: VerificationApproach;
  flow?: VerificationFlow;
  /** Absent on a report from before coverage was counted. */
  coverage?: VerificationCoverage | UnknownCoverage;
}

/**
 * The part of the sidecar's `VerificationSize` the tab shows: what the
 * agents won't read whole.
 */
export interface VerificationSize {
  /** Changed files with no text diff, so no patch for the agents. */
  binary: string[];
  /** Changed files whose diff is too large, so the agents see only its start. */
  truncated: string[];
  /** Lockfiles and generated, vendored or minified files, which the agents only skim. */
  skimmed: string[];
}

/** Mirrors the sidecar's `Tripwire` (`reviewWorkspaces/tripwires.ts`). */
export interface VerificationTripwire {
  kind: "build" | "binary" | "hidden-text" | "opaque-blob" | "test-tampering";
  path: string;
  line?: number;
  note: string;
}

/** The checks shown as one row each, in the order the report lists them. */
export const VERIFICATION_CHECKS = [
  "malice",
  "tests",
  "complexity",
  "performance",
  "comments",
  "observability",
  "quality",
] as const;
export type VerificationCheckKey = (typeof VERIFICATION_CHECKS)[number];

/** What each check is called, in the report, on the diff and in drafted comments. */
export const CHECK_LABEL: Record<VerificationCheckKey, string> = {
  malice: "Malicious intent",
  tests: "Test quality",
  complexity: "Complexity",
  performance: "Performance",
  comments: "Comment quality",
  observability: "Observability",
  quality: "Code quality",
};

/**
 * The sections a reviewer can run, in report order; mirrors the sidecar's
 * `REPORT_SECTIONS`. `summary` is the summary and must-read files.
 */
export const REPORT_SECTIONS = [
  "summary",
  "changeMap",
  "claims",
  "risk",
  ...VERIFICATION_CHECKS,
  "approach",
  "flow",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** What runs when no sections are picked: everything but the diagram. */
export const DEFAULT_SECTIONS: readonly ReportSection[] = REPORT_SECTIONS.filter(
  (s) => s !== "flow",
);

/**
 * Mentions as plain text: a zero-width space after the `@` keeps GitHub from
 * notifying anyone, or a bot from reading a command addressed to it.
 */
const unmention = (text: string) => text.replace(/@(?=[\w-])/g, "@\u200b");

/**
 * A finding as a review comment's text: its title, then what the report said,
 * quoted. Marked as coming from the report so a reader on the PR doesn't take
 * it for the reviewer's own words. The text is model-written from the PR's
 * code, so it is quoted and stripped of mentions, and the title is kept to one
 * line: posted under the reviewer's account, a `/approve` line or an `@bot` in
 * it would carry their authority.
 */
export function findingCommentBody(
  finding: { title: string; detail: string; severity?: Severity },
  section: string,
): string {
  const tag = finding.severity ? `${section}, ${finding.severity}` : section;
  const quoted = unmention(finding.detail)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const title = unmention(finding.title).replace(/\s+/g, " ").trim();
  return `**${title}** (verification report: ${tag})\n\n${quoted}`;
}

/** Mirrors the sidecar's `ChecklistRun`: a run's state, without its answer. */
export interface ChecklistRun {
  id: string;
  status: AgentRunStatus;
  /** Whether this sidecar is running it, so its events can be followed live. */
  live: boolean;
  /** The commit it ran against. */
  headSha: string | null;
  /** True when that is the PR's head now. */
  current: boolean;
  error: string | null;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export type ChecklistThemeId = "understand" | "correctness" | "risk" | "maintainability";

export interface ChecklistItem {
  section: ReportSection;
  theme: ChecklistThemeId;
  label: string;
  /** What the section checks, in a sentence. */
  description: string;
  /** The newest run that wrote this section, whatever its outcome. */
  latest: ChecklistRun | null;
  /** The newest run that answered for it: the one the report shows. */
  result: ChecklistRun | null;
}

/** Mirrors the sidecar's `VerificationChecklist`. */
export interface VerificationChecklist {
  /** The PR's head now. */
  headSha: string | null;
  themes: readonly { id: ChecklistThemeId; label: string }[];
  /** In report order. */
  items: ChecklistItem[];
  /** Each section's newest result put together; null until any section has one. */
  report: VerificationReport | null;
  /** What the agents won't read whole. Null until the PR is ready to read. */
  size: VerificationSize | null;
  /** The tickets the reviewer named for the newest run that read tickets, to offer again. */
  namedTickets: string[];
}

const path = (workspaceId: string, prId: string) =>
  `/api/review-workspaces/${workspaceId}/prs/${prId}/verification`;

export async function verificationChecklist(
  workspaceId: string,
  prId: string,
): Promise<VerificationChecklist> {
  const res = await sidecarFetch(path(workspaceId, prId));
  await ensureOk(res, "read verification checklist");
  const checklist = (await res.json()) as VerificationChecklist;
  const { report } = checklist;
  // The sidecar omits `mustRead` when no summary result exists; the tab treats that as an empty list.
  return report
    ? { ...checklist, report: { ...report, mustRead: report.mustRead ?? [] } }
    : checklist;
}

export type EvidenceSeverity = "high" | "medium" | "low" | "info";

/** One thing a CI check, scanner or bot reported. Every string is theirs, so it is shown as plain text. */
export interface EvidenceEntry {
  source: string;
  title: string;
  detail: string;
  severity: EvidenceSeverity;
  path: string | null;
  line: number | null;
  url: string | null;
}

export type EvidenceId =
  | "ci-checks"
  | "code-scanning"
  | "security-bots"
  | "coverage-bots"
  | "other-bots";

/** What other tools said about the PR, shown on the checklist under its theme. */
export interface EvidenceItem {
  id: EvidenceId;
  theme: ChecklistThemeId;
  label: string;
  description: string;
  summary: string;
  tone: "good" | "warn" | "bad" | "muted";
  entries: EvidenceEntry[];
  hiddenEntries: number;
  note: string | null;
}

export interface VerificationEvidence {
  /** The commit the provider reports as the PR's head, which the checks ran on. */
  headSha: string;
  items: EvidenceItem[];
}

/** The PR's CI checks, code scanning alerts and bot comments, read from its provider. */
export async function verificationEvidence(
  workspaceId: string,
  prId: string,
): Promise<VerificationEvidence> {
  const res = await sidecarFetch(`/api/review-workspaces/${workspaceId}/prs/${prId}/evidence`);
  await ensureOk(res, "read CI evidence");
  return (await res.json()) as VerificationEvidence;
}

/** Mirrors the sidecar's `UpstackChanges` (`pr/upstack.ts`). */
export interface VerificationUpstack {
  /** This PR's head as the provider has it, which the layers' line numbers are against. */
  headSha: string | null;
  layers: {
    number: number;
    url: string;
    /** Not built on this PR's current head, so its line numbers don't match. */
    stale: boolean;
    /** `ranges` null: the layer deletes the file or its patch can't be read, so any line may have changed. */
    files: { path: string; ranges: { start: number; end: number }[] | null }[];
  }[];
  note: string | null;
}

/** What the PRs stacked directly on this one change in it. */
export async function verificationUpstack(
  workspaceId: string,
  prId: string,
): Promise<VerificationUpstack> {
  const res = await sidecarFetch(`/api/review-workspaces/${workspaceId}/prs/${prId}/upstack`);
  await ensureOk(res, "read the PRs stacked above");
  return (await res.json()) as VerificationUpstack;
}

/** How close a layer's change must be to a finding's line to count as touching it. */
const UPSTACK_NEARBY_LINES = 3;

/**
 * The layer above that changes the line a finding is on, or null. A layer
 * built on this PR's head diffs against it, so its base-side ranges are this
 * PR's head lines; a stale one's aren't, and is never matched. A finding with
 * no line counts when the layer changes the file at all.
 */
export function changedUpstack(
  upstack: VerificationUpstack | null,
  path: string | undefined,
  line: number | undefined,
): { number: number; url: string } | null {
  if (!upstack || !path) return null;
  for (const layer of upstack.layers) {
    if (layer.stale) continue;
    const file = layer.files.find((f) => f.path === path);
    if (!file) continue;
    if (file.ranges === null || line === undefined) return layer;
    const near = file.ranges.some(
      (r) => line >= r.start - UPSTACK_NEARBY_LINES && line <= r.end + UPSTACK_NEARBY_LINES,
    );
    if (near) return layer;
  }
  return null;
}

export interface StartedCheck {
  section: ReportSection;
  runId: string;
  /** True when a run writing this section was already going, and nothing new started. */
  existing: boolean;
}

/**
 * Starts a run for each of `sections`; a section with a run already going
 * joins it. `failed` names the sections whose run couldn't start; it throws
 * only when none started or joined a run.
 */
export async function startVerification(
  workspaceId: string,
  prId: string,
  sections: readonly ReportSection[],
  /** Tickets for the change map and claims, as keys or links, beside the ones the PR links. */
  namedTickets: readonly string[] = [],
): Promise<{ runs: StartedCheck[]; failed: { section: ReportSection; error: string }[] }> {
  const res = await sidecarFetch(path(workspaceId, prId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sections, ...(namedTickets.length > 0 && { namedTickets }) }),
  });
  await ensureOk(res, "start verification checks");
  return res.json();
}
