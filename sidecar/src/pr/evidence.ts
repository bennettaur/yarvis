/**
 * What other tools already said about a pull request: its CI checks and their
 * line annotations, open code-scanning alerts, and comments bots left on it.
 * The verification checklist shows these beside the checks Yarvis runs, so a
 * reviewer sees a failing build or a scanner's finding before paying for an
 * agent to look.
 *
 * Every string here was written by a check, a scanner or a bot, so it is shown
 * as plain text and never put into a prompt.
 */

import { clientError, describeError } from "../llm/errors.ts";
import { type CheckOutcome, checkOutcome } from "../reviewWorkspaces/verification.ts";
import type { PrCodeSource } from "./source.ts";
import {
  type AnnotationLevel,
  type CheckAnnotation,
  type CheckItem,
  type CheckRunOutput,
  EvidenceUnavailable,
  type ReviewComment,
  type ScanAlert,
} from "./types.ts";

export type EvidenceSeverity = "high" | "medium" | "low" | "info";

/** One thing a tool reported, in the shape the checklist lists them. */
export interface EvidenceEntry {
  /** Who said it: a check's name, a scanner, or a bot's login. */
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

export type EvidenceTheme = "correctness" | "risk" | "maintainability";

export type EvidenceTone = "good" | "warn" | "bad" | "muted";

export interface EvidenceItem {
  id: EvidenceId;
  theme: EvidenceTheme;
  label: string;
  description: string;
  /** A short tally, such as "1 of 12 failing". */
  summary: string;
  tone: EvidenceTone;
  entries: EvidenceEntry[];
  /** Entries the provider has that aren't in `entries`, past a cap. */
  hiddenEntries: number;
  /** Why this couldn't be read in full, when it couldn't. */
  note: string | null;
}

export interface PrEvidence {
  /** The commit the provider reports as the PR's head, which the checks ran on. */
  headSha: string;
  items: EvidenceItem[];
}

/** Enough to show what is wrong; a long scanner report is read on the provider. */
const MAX_TEXT_CHARS = 400;
/** A title is one line; the detail under it carries the rest. */
const MAX_TITLE_CHARS = 120;
/** Checks whose annotations are read, failing ones first. Each is one request. */
const MAX_ANNOTATED_CHECKS = 10;
/** Entries shown per item. */
const MAX_ENTRIES = 50;

const ITEM_INFO: Record<EvidenceId, Pick<EvidenceItem, "theme" | "label" | "description">> = {
  "ci-checks": {
    theme: "correctness",
    label: "CI checks",
    description: "The PR's CI checks, with the lines their failures and warnings point at.",
  },
  "code-scanning": {
    theme: "risk",
    label: "Code scanning alerts",
    description: "Open alerts from code scanners such as CodeQL and Semgrep on this PR.",
  },
  "security-bots": {
    theme: "risk",
    label: "Security bot comments",
    description: "What security and dependency scanners commented on the PR.",
  },
  "coverage-bots": {
    theme: "correctness",
    label: "Coverage bot comments",
    description: "What coverage reporters commented on the PR.",
  },
  "other-bots": {
    theme: "maintainability",
    label: "Other bot comments",
    description: "What other bots, such as linters and review bots, commented on the PR.",
  },
};

/** Logins of bots whose comments are about security or dependencies, matched as substrings. */
const SECURITY_BOTS = [
  "semgrep",
  "snyk",
  "socket",
  "gitguardian",
  "aikido",
  "codeql",
  "advanced-security",
  "dependabot",
  "sonar",
  "mend",
  "checkmarx",
  "trivy",
  "endorlabs",
];
const COVERAGE_BOTS = ["codecov", "coveralls"];

export function botKind(login: string): "security-bots" | "coverage-bots" | "other-bots" {
  const name = login.toLowerCase();
  if (SECURITY_BOTS.some((b) => name.includes(b))) return "security-bots";
  if (COVERAGE_BOTS.some((b) => name.includes(b))) return "coverage-bots";
  return "other-bots";
}

/**
 * Text a tool wrote, as one plain line. Bot comments are markdown with HTML
 * folded in (badges, `<details>`), none of which reads as plain text.
 */
export function plainText(text: string, max = MAX_TEXT_CHARS): string {
  // Anyone who opens a PR can write annotations, so the text may be built to
  // be slow. Only a few times what is kept is read, and every repeat is
  // bounded, so the cost stays linear in that.
  const flat = text
    .slice(0, max * 4)
    .replace(/<!--[\s\S]{0,500}?-->/g, " ")
    .replace(/!\[[^\]]{0,500}\]\([^)]{0,500}\)/g, " ")
    .replace(/\[([^\]]{0,500})\]\([^)]{0,500}\)/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]{0,500}>/g, " ")
    // Headings and quotes at a line's start, bold and code marks anywhere.
    .replace(/^[ \t]{0,3}(?:#{1,6}|>+)[ \t]*/gm, "")
    .replace(/\*\*|`/g, "")
    // Control, zero-width and bidi characters can make text read as something else.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

/** Only an https link is offered, since anyone who posts a check picks its URL. */
function httpsUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\/\S+$/.test(url) ? url : null;
}

const OUTCOME_SEVERITY: Partial<Record<CheckOutcome, EvidenceSeverity>> = {
  failed: "high",
  cancelled: "low",
  unknown: "low",
  pending: "info",
};

const ANNOTATION_SEVERITY: Record<AnnotationLevel, EvidenceSeverity> = {
  failure: "high",
  warning: "medium",
  notice: "info",
};

function alertSeverity(severity: string): EvidenceSeverity {
  switch (severity) {
    case "critical":
    case "high":
    case "error":
      return "high";
    case "medium":
    case "warning":
      return "medium";
    case "low":
    case "note":
      return "low";
    default:
      return "info";
  }
}

const SEVERITY_ORDER: EvidenceSeverity[] = ["high", "medium", "low", "info"];

function toneOf(entries: EvidenceEntry[]): EvidenceTone {
  if (entries.some((e) => e.severity === "high")) return "bad";
  if (entries.some((e) => e.severity === "medium")) return "warn";
  return entries.length === 0 ? "good" : "muted";
}

function evidenceItem(
  id: EvidenceId,
  entries: EvidenceEntry[],
  {
    summary,
    note = null,
    tone = toneOf(entries),
    unread = 0,
  }: {
    summary: string;
    note?: string | null;
    tone?: EvidenceTone;
    /** Entries the provider has that were never read, such as annotations past a cap. */
    unread?: number;
  },
): EvidenceItem {
  const sorted = [...entries].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  return {
    id,
    ...ITEM_INFO[id],
    summary,
    tone,
    entries: sorted.slice(0, MAX_ENTRIES),
    hiddenEntries: Math.max(0, sorted.length - MAX_ENTRIES) + unread,
    note,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Why a read failed, for the item's note. */
function unavailableNote(what: string, e: unknown): string {
  if (e instanceof EvidenceUnavailable) return e.message;
  console.error(`[evidence] could not read ${what}:`, describeError(e));
  return `Couldn't read ${what}: ${clientError(e)}`;
}

/**
 * The output a check posted. Matched on GitHub's run id, since two workflows
 * can each have a job called "build"; by name only when one run has it.
 */
function outputFor(check: CheckItem, outputs: CheckRunOutput[]): CheckRunOutput | undefined {
  if (check.checkRunId !== undefined) return outputs.find((o) => o.id === check.checkRunId);
  const named = outputs.filter((o) => o.name === check.name);
  return named.length === 1 ? named[0] : undefined;
}

/**
 * The CI checks item: each check that didn't pass, and the lines its run
 * pointed at. A passing check's warnings are listed too, since a linter that
 * only warns still passes.
 */
function ciChecksItem(
  checks: CheckItem[],
  outputs: CheckRunOutput[],
  annotations: Map<number, CheckAnnotation[]>,
  notes: string[],
): EvidenceItem {
  const entries: EvidenceEntry[] = [];
  let unread = 0;
  const outcomes = checks.map((c) => ({ check: c, outcome: checkOutcome(c) }));
  for (const { check, outcome } of outcomes) {
    const name = plainText(check.name, MAX_TITLE_CHARS);
    const output = outputFor(check, outputs);
    const severity = OUTCOME_SEVERITY[outcome];
    if (severity) {
      entries.push({
        source: name,
        title: `${name}: ${outcome}`,
        detail: plainText(output?.title ?? output?.summary ?? ""),
        severity,
        path: null,
        line: null,
        url: httpsUrl(check.url),
      });
    }
    if (!output) continue;
    const read = annotations.get(output.id) ?? [];
    unread += Math.max(0, output.annotationsCount - read.length);
    for (const a of read) {
      entries.push({
        source: name,
        title: plainText(a.title ?? `${name} ${a.level}`, MAX_TITLE_CHARS),
        detail: plainText(a.message),
        severity: ANNOTATION_SEVERITY[a.level],
        path: a.path,
        line: a.line,
        url: httpsUrl(check.url),
      });
    }
  }
  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  const pending = outcomes.filter((o) => o.outcome === "pending").length;
  let summary: string;
  if (checks.length === 0) summary = "No checks reported";
  else if (failed > 0) summary = `${failed} of ${checks.length} failing`;
  else if (pending > 0) summary = `${pending} of ${checks.length} still running`;
  else summary = `All ${checks.length} passed`;
  return evidenceItem("ci-checks", entries, {
    summary,
    note: notes.length > 0 ? notes.join(" ") : null,
    // No checks at all isn't good news, though nothing failed.
    ...(checks.length === 0 ? { tone: "muted" as const } : {}),
    unread,
  });
}

function codeScanningItem(alerts: ScanAlert[] | null, note: string | null): EvidenceItem {
  if (alerts === null) {
    return evidenceItem("code-scanning", [], { summary: "Not available", note, tone: "muted" });
  }
  const entries = alerts.map(
    (a): EvidenceEntry => ({
      source: plainText(a.tool, MAX_TITLE_CHARS),
      title: plainText(a.description || a.rule, MAX_TITLE_CHARS),
      detail: plainText(a.message),
      severity: alertSeverity(a.severity),
      path: a.path,
      line: a.line,
      url: httpsUrl(a.url),
    }),
  );
  return evidenceItem("code-scanning", entries, {
    summary: alerts.length === 0 ? "No open alerts" : plural(alerts.length, "open alert"),
    note,
  });
}

/** A comment with where it was left: a file and line for a review thread, none for the conversation. */
interface PlacedComment {
  comment: ReviewComment;
  path: string | null;
  line: number | null;
  resolved: boolean;
}

/**
 * One item per kind of bot that commented. A resolved thread is left out, since
 * someone already dealt with it. Severity is unknown from a comment alone, so a
 * security bot's comment reads as medium and the rest as low.
 */
function botItems(placed: PlacedComment[]): EvidenceItem[] {
  const byKind = new Map<EvidenceId, EvidenceEntry[]>();
  for (const { comment, path, line, resolved } of placed) {
    if (resolved || !comment.isBot) continue;
    const kind = botKind(comment.author);
    const text = plainText(comment.body);
    if (!text) continue;
    const entries = byKind.get(kind) ?? [];
    entries.push({
      source: comment.author,
      title: comment.author,
      detail: text,
      severity: kind === "security-bots" ? "medium" : "low",
      path,
      line,
      url: httpsUrl(comment.url),
    });
    byKind.set(kind, entries);
  }
  return (["security-bots", "coverage-bots", "other-bots"] as const)
    .filter((kind) => byKind.has(kind))
    .map((kind) => {
      const entries = byKind.get(kind) ?? [];
      return evidenceItem(kind, entries, { summary: plural(entries.length, "comment") });
    });
}

/**
 * Everything other tools said about the PR, read from its provider. Each part
 * is read on its own, so a token that can't see code scanning still gets the
 * CI checks. Only the PR itself failing to load fails the whole read.
 */
export async function prEvidence(source: PrCodeSource): Promise<PrEvidence> {
  // Alerts don't need the head commit, so they are read alongside the PR.
  const alertsRead = source.codeScanningAlerts().then(
    (list) => ({ list, note: list === null ? "This provider has no code scanning alerts." : null }),
    (e) => ({ list: null, note: unavailableNote("code scanning alerts", e) }),
  );
  const [detail, checks] = await Promise.all([source.detail(), source.ciChecks()]);
  const notes: string[] = [];
  if (detail.checksUnavailable) {
    notes.push("Some checks are hidden from the configured token, so this list is incomplete.");
  }

  const [runs, alerts] = await Promise.all([
    source.checkRunOutputs(detail.headSha).then(
      (list) => ({ list: list ?? [], note: null }),
      (e) => ({ list: [], note: unavailableNote("the checks' output", e) }),
    ),
    alertsRead,
  ]);
  if (runs.note) notes.push(runs.note);

  // Failing checks first, so the cap leaves out passing checks' notices rather than failures.
  const failingRuns = new Set(
    checks
      .filter((c) => checkOutcome(c) === "failed")
      .map((c) => outputFor(c, runs.list)?.id)
      .filter((id) => id !== undefined),
  );
  const checksToAnnotate = runs.list
    .filter((o) => o.annotationsCount > 0)
    .sort((a, b) => Number(failingRuns.has(b.id)) - Number(failingRuns.has(a.id)))
    .slice(0, MAX_ANNOTATED_CHECKS);
  const annotations = new Map<number, CheckAnnotation[]>();
  const unreadable: string[] = [];
  await Promise.all(
    checksToAnnotate.map(async (o) => {
      try {
        annotations.set(o.id, await source.checkRunAnnotations(o.id));
      } catch (e) {
        console.error(`[evidence] could not read annotations of ${o.name}:`, describeError(e));
        unreadable.push(plainText(o.name, MAX_TITLE_CHARS));
      }
    }),
  );
  if (unreadable.length > 0) {
    notes.push(`Couldn't read the annotations of ${unreadable.join(", ")}.`);
  }

  const placed: PlacedComment[] = [
    ...detail.reviewThreads.flatMap((t) =>
      t.comments.map((comment) => ({
        comment,
        path: t.path,
        line: t.line,
        resolved: t.isResolved,
      })),
    ),
    ...(detail.conversation ?? []).map((comment) => ({
      comment,
      path: null,
      line: null,
      resolved: false,
    })),
  ];

  return {
    headSha: detail.headSha,
    items: [
      ciChecksItem(checks, runs.list, annotations, notes),
      codeScanningItem(alerts.list, alerts.note),
      ...botItems(placed),
    ],
  };
}
