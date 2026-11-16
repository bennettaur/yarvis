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

import { describeError } from "../llm/errors.ts";
import { type CheckOutcome, checkOutcome } from "../reviewWorkspaces/verification.ts";
import type { PrCodeSource } from "./source.ts";
import type { CheckItem, ReviewComment } from "./types.ts";

/** A check run's output on GitHub: its headline, summary and line annotations. */
export interface CheckRunOutput {
  id: number;
  name: string;
  /** The app that posted it, such as "github-actions" or "semgrep". */
  app: string | null;
  title: string | null;
  summary: string | null;
  annotationsCount: number;
}

export type AnnotationLevel = "failure" | "warning" | "notice";

export interface CheckAnnotation {
  path: string;
  line: number | null;
  level: AnnotationLevel;
  title: string | null;
  message: string;
}

export interface ScanAlert {
  number: number;
  tool: string;
  rule: string;
  /** "critical" | "high" | "medium" | "low" for security rules, else "error" | "warning" | "note". */
  severity: string;
  description: string;
  path: string | null;
  line: number | null;
  message: string;
  url: string | null;
}

/** What a provider can't show, as opposed to there being nothing to show. */
export class EvidenceUnavailable extends Error {}

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

export const EVIDENCE_IDS = [
  "ci-checks",
  "code-scanning",
  "security-bots",
  "coverage-bots",
  "other-bots",
] as const;
export type EvidenceId = (typeof EVIDENCE_IDS)[number];

export type EvidenceTheme = "correctness" | "risk" | "maintainability";

export interface EvidenceItem {
  id: EvidenceId;
  theme: EvidenceTheme;
  label: string;
  description: string;
  /** A short tally, such as "1 of 12 failing". */
  summary: string;
  tone: "good" | "warn" | "bad" | "muted";
  entries: EvidenceEntry[];
  /** Entries left off past the cap. */
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
/** How much of a comment is cleaned up, which keeps the regexes cheap on a huge one. */
const MAX_SCANNED_CHARS = 8000;
/** Checks whose annotations are read, failing ones first. Each is one request. */
const MAX_ANNOTATED_CHECKS = 10;
/** Entries shown per item. */
const MAX_ENTRIES = 50;

const ENTRIES: Record<EvidenceId, Pick<EvidenceItem, "theme" | "label" | "description">> = {
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
  // A comment can run to 64k characters; past this much nothing more is shown anyway.
  const flat = text
    .slice(0, MAX_SCANNED_CHARS)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]{0,500}>/g, " ")
    // Headings and quotes at a line's start, bold and code marks anywhere.
    .replace(/^[ \t]{0,3}(?:#{1,6}|>+)[ \t]*/gm, "")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

export function alertSeverity(severity: string): EvidenceSeverity {
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

function toneOf(entries: EvidenceEntry[]): EvidenceItem["tone"] {
  if (entries.some((e) => e.severity === "high")) return "bad";
  if (entries.some((e) => e.severity === "medium")) return "warn";
  return entries.length === 0 ? "good" : "muted";
}

function item(
  id: EvidenceId,
  entries: EvidenceEntry[],
  summary: string,
  note: string | null = null,
  tone: EvidenceItem["tone"] = toneOf(entries),
): EvidenceItem {
  const sorted = [...entries].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  return {
    id,
    ...ENTRIES[id],
    summary,
    tone,
    entries: sorted.slice(0, MAX_ENTRIES),
    hiddenEntries: Math.max(0, sorted.length - MAX_ENTRIES),
    note,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Why a read failed, for the item's note. */
function unavailableNote(what: string, e: unknown): string {
  return e instanceof EvidenceUnavailable
    ? e.message
    : `Couldn't read ${what}: ${describeError(e)}`;
}

/**
 * The CI checks item: each check that didn't pass, and the lines its run
 * pointed at. A passing check's warnings are listed too, since a linter that
 * only warns still passes.
 */
export function ciChecksItem(
  checks: CheckItem[],
  outputs: CheckRunOutput[] | null,
  annotations: Map<number, CheckAnnotation[]>,
  notes: string[],
): EvidenceItem {
  const entries: EvidenceEntry[] = [];
  const outcomes = checks.map((c) => ({ check: c, outcome: checkOutcome(c) }));
  for (const { check, outcome } of outcomes) {
    const output = outputs?.find((o) => o.name === check.name);
    const severity = OUTCOME_SEVERITY[outcome];
    if (severity) {
      entries.push({
        source: check.name,
        title: `${check.name}: ${outcome}`,
        detail: plainText(output?.title ?? output?.summary ?? ""),
        severity,
        path: null,
        line: null,
        url: httpsUrl(check.url),
      });
    }
    for (const a of output ? (annotations.get(output.id) ?? []) : []) {
      entries.push({
        source: check.name,
        title: plainText(a.title ?? `${check.name} ${a.level}`, 120),
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
  const tone = checks.length === 0 ? "muted" : toneOf(entries);
  return item("ci-checks", entries, summary, notes.length > 0 ? notes.join(" ") : null, tone);
}

export function codeScanningItem(alerts: ScanAlert[] | null, note: string | null): EvidenceItem {
  if (alerts === null) return item("code-scanning", [], "Not available", note, "muted");
  const entries = alerts.map(
    (a): EvidenceEntry => ({
      source: a.tool,
      title: plainText(a.description || a.rule, 120),
      detail: plainText(a.message),
      severity: alertSeverity(a.severity),
      path: a.path,
      line: a.line,
      url: httpsUrl(a.url),
    }),
  );
  return item(
    "code-scanning",
    entries,
    alerts.length === 0 ? "No open alerts" : plural(alerts.length, "open alert"),
    note,
  );
}

interface BotNote {
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
export function botItems(notes: BotNote[]): EvidenceItem[] {
  const byKind = new Map<EvidenceId, EvidenceEntry[]>();
  for (const { comment, path, line, resolved } of notes) {
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
      return item(kind, entries, plural(entries.length, "comment"));
    });
}

/**
 * Everything other tools said about the PR, read from its provider. Each part
 * is read on its own, so a token that can't see code scanning still gets the
 * CI checks.
 */
export async function prEvidence(source: PrCodeSource): Promise<PrEvidence> {
  const detail = await source.detail();
  const notes: string[] = [];
  if (detail.checksUnavailable) {
    notes.push("Some checks are hidden from the configured token, so this list is incomplete.");
  }

  const [outputs, alerts] = await Promise.all([
    source.checkRunOutputs(detail.headSha).catch((e) => {
      notes.push(unavailableNote("the checks' output", e));
      return null;
    }),
    source.codeScanningAlerts().then(
      (list) => ({
        list,
        note: list === null ? "This provider has no code scanning alerts." : null,
      }),
      (e) => ({ list: null, note: unavailableNote("code scanning alerts", e) }),
    ),
  ]);

  // Failing checks first, so a cap leaves out the passing ones' notices.
  const failing = new Set(
    detail.checks.filter((c) => checkOutcome(c) === "failed").map((c) => c.name),
  );
  const annotated = (outputs ?? [])
    .filter((o) => o.annotationsCount > 0)
    .sort((a, b) => Number(failing.has(b.name)) - Number(failing.has(a.name)))
    .slice(0, MAX_ANNOTATED_CHECKS);
  const annotations = new Map<number, CheckAnnotation[]>();
  await Promise.all(
    annotated.map(async (o) => {
      try {
        annotations.set(o.id, await source.checkRunAnnotations(o.id));
      } catch (e) {
        console.error(`[evidence] could not read annotations of ${o.name}:`, describeError(e));
      }
    }),
  );

  const botNotes: BotNote[] = [
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
      ciChecksItem(detail.checks, outputs, annotations, notes),
      codeScanningItem(alerts.list, alerts.note),
      ...botItems(botNotes),
    ],
  };
}
