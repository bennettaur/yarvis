import { useMemo, useState } from "react";
import { parsePatch } from "../../../lib/pr/diff";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { rowsInRange } from "../../../lib/reviewWorkspaces/story";
import {
  APPROACH_LABEL,
  asMitigation,
  CHECK_LABEL,
  type ChangeKind,
  type ClaimStatus,
  changedUpstack,
  coverageKnown,
  type ImpactBand,
  type ReportSection,
  type Severity,
  THEME_RISK_LABEL,
  type ThemeCohesion,
  type ThemeRisk,
  VERIFICATION_CHECKS,
  type VerificationApproach,
  type VerificationChange,
  type VerificationChangeMap,
  type VerificationCheck,
  type VerificationCheckKey,
  type VerificationClaims,
  type VerificationConcern,
  type VerificationCoverage,
  type VerificationImpact,
  type VerificationMitigation,
  type VerificationMustRead,
  type VerificationProof,
  type VerificationReport,
  type VerificationTripwire,
  type VerificationUpstack,
} from "../../../lib/reviewWorkspaces/verification";
import { openExternal } from "../../../lib/url";
import { rowClass } from "../../diff/DiffRow";
import { type ReportActions, ReportItemActions } from "./ReportItemActions";
import { useReviewFileDiff } from "./reviewData";

export type { FindingPoster, Located, ReportActions } from "./ReportItemActions";

/** What a must-read's flags are called, in the report and on the diff. */
export const FLAG_LABEL = "Looks off";

const SEVERITY_CLASS: Record<Severity, string> = {
  high: "border-red-800 text-red-300",
  medium: "border-amber-800 text-amber-300",
  low: "border-zinc-700 text-zinc-400",
};

type VerificationRiskLevel = NonNullable<VerificationReport["risk"]>["level"];

const RISK_CLASS: Record<VerificationRiskLevel, string> = {
  high: "border-red-700 bg-red-950/40 text-red-300",
  medium: "border-amber-700 bg-amber-950/40 text-amber-300",
  low: "border-emerald-800 bg-emerald-950/30 text-emerald-300",
};

const THEME_RISK_CLASS: Record<ThemeRisk, string> = {
  ...RISK_CLASS,
  none: "border-zinc-700 text-zinc-400",
};

const THEME_RISK_HELP =
  "How bad a mistake in this theme would be, before any proof. High: breaks users, data, money, security or a contract. Medium: breaks a feature. Low: an annoyance with a workaround. None: nothing a mistake could hurt.";

const COHESION_LABEL: Record<ThemeCohesion, string> = {
  core: "Core",
  supporting: "Supporting",
  outlier: "Outlier",
};

const COHESION_CLASS: Record<ThemeCohesion, string> = {
  core: "border-sky-800 text-sky-300",
  supporting: "border-zinc-700 text-zinc-400",
  outlier: "border-amber-700 text-amber-300",
};

export const CLAIM_LABEL: Record<ClaimStatus, string> = {
  verified: "Verified",
  partial: "Partial",
  missing: "Missing",
  contradicted: "Contradicted",
  unverifiable: "Can't tell",
};

const CLAIM_CLASS: Record<ClaimStatus, string> = {
  verified: "border-emerald-800 text-emerald-300",
  partial: "border-amber-700 text-amber-300",
  missing: "border-red-700 text-red-300",
  contradicted: "border-red-700 text-red-300",
  unverifiable: "border-zinc-700 text-zinc-400",
};

/** Claims a reviewer may want to raise with the author: the code doesn't do what was said. */
export const isUnmetClaim = (status: ClaimStatus) =>
  status === "partial" || status === "missing" || status === "contradicted";

// The band labels, kind names and attention band copy `sidecar/src/verify/impact.ts`, the
// evidence text copies `scripts/verify/report.ts`, and `LEVEL_FOR_BAND` copies the sidecar's
// `reviewWorkspaces/verification.ts`. The frontend can't import them, so change both together.
const IMPACT_LABEL: Record<ImpactBand, string> = {
  1: "minimal",
  2: "low",
  3: "moderate",
  4: "high",
  5: "very high",
};

const IMPACT_CLASS: Record<ImpactBand, string> = {
  1: RISK_CLASS.low,
  2: RISK_CLASS.low,
  3: RISK_CLASS.medium,
  4: RISK_CLASS.high,
  5: RISK_CLASS.high,
};

/** Changes at or above this band are listed for attention; the sidecar's `ATTENTION_BAND`. */
const ATTENTION_BAND = 4;

/** The risk level a band alone implies. */
const LEVEL_FOR_BAND: Record<ImpactBand, VerificationRiskLevel> = {
  1: "low",
  2: "low",
  3: "medium",
  4: "high",
  5: "high",
};

const KIND_NAMES: [ChangeKind, string, string][] = [
  ["passive", "passive", "passive"],
  ["reorganization", "reorganization", "reorganizations"],
  ["addition", "addition", "additions"],
  ["removal", "removal", "removals"],
  ["interface", "interface change", "interface changes"],
  ["logic", "logic change", "logic changes"],
];

const EVIDENCE_TEXT: Record<VerificationChange["evidence"], string> = {
  proven: "proven by tests",
  partial: "partly tested",
  unproven: "untested",
};

// What each trait means, for a reader who doesn't know the scoring. Copies the
// definitions the risk agent classifies by (`yarvis-review/agents/risk-reviewer.md`).
const KIND_HELP: Record<ChangeKind, string> = {
  passive: "What it does: comments, formatting, docs or tests only. Behaviour can't change.",
  reorganization: "What it does: code moved or split, with the same behaviour.",
  addition: "What it does: new code that only a new flag, setting or endpoint reaches.",
  removal: "What it does: deletes code.",
  interface: "What it does: changes a signature, schema, API or config key other code relies on.",
  logic: "What it does: an existing input now gets a different result or path.",
};

const REACH_HELP: Record<VerificationChange["reach"], string> = {
  leaf: "Reach: used only in its own file, a test or a script.",
  local: "Reach: used within its own module and at most one other.",
  shared: "Reach: used from two to four other modules.",
  core: "Reach: used from five or more modules, or something many features go through.",
};

const EVIDENCE_HELP: Record<VerificationChange["evidence"], string> = {
  proven: "Proof: a test that runs this would fail without the change.",
  partial: "Proof: tests run some of it, but not all of what could break.",
  unproven: "Proof: no test runs the changed lines.",
};

const BAND_HELP =
  "Impact, 1 to 5: how far a mistake in this change could spread. Scored the same way every time from what the change does, how much code uses it, and whether tests prove it. 4 and above needs a reviewer's attention.";

function countsText(counts: VerificationImpact["counts"]): string {
  return KIND_NAMES.filter(([kind]) => counts[kind] > 0)
    .map(([kind, one, many]) => `${counts[kind]} ${counts[kind] === 1 ? one : many}`)
    .join(", ");
}

/**
 * Props for an element whose tooltip explains it. Focusable and labelled, so
 * a keyboard or screen-reader user gets the explanation a mouse user hovers for.
 */
const explained = (text: string, help: string) => ({
  title: help,
  tabIndex: 0,
  "aria-label": `${text}: ${help}`,
});

/** A small labelled chip whose tooltip says what it means. */
function Trait({ text, help, className = "" }: { text: string; help: string; className?: string }) {
  return (
    <span
      {...explained(text, help)}
      className={`cursor-help rounded border border-zinc-700 px-1 py-0.5 text-[10px] text-zinc-400 ${className}`}
    >
      {text}
    </span>
  );
}

/** A change's kind, reach and proof as chips a reader can hover to learn what they mean. */
function ChangeTraits({ change }: { change: VerificationChange }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Trait text={`${change.band}/5`} help={BAND_HELP} className={IMPACT_CLASS[change.band]} />
      <Trait text={change.kind} help={KIND_HELP[change.kind]} />
      <Trait text={`reach: ${change.reach}`} help={REACH_HELP[change.reach]} />
      <Trait text={EVIDENCE_TEXT[change.evidence]} help={EVIDENCE_HELP[change.evidence]} />
      {change.sensitive && (
        <Trait
          text="sensitive"
          help="Touches secrets, permissions, what an agent may do, or deletes or migrates data. Raises the score by one."
        />
      )}
      {!change.sensitive && change.internal && (
        <Trait
          text="internal only"
          help="A mistake can reach only staff, not clients. Lowers the score by one."
        />
      )}
      {change.count > 1 && (
        <Trait text={`×${change.count}`} help="This entry stands for this many similar changes." />
      )}
    </span>
  );
}

/**
 * Proofs and mitigations are the agent's reading of a checkout the PR's author
 * wrote, so the label says to confirm them rather than take them as checked.
 */
const CLAIM_HELP =
  "What the agent says it found. Open the file to confirm it: a test's name or a comment is not proof.";

/** A proof or mitigation: what it shows, and where in the code. */
function EvidenceLine({ proof, onOpen }: { proof: VerificationProof; onOpen: OpenLocation }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <span className="text-emerald-200/90">{proof.text}</span>
      <Location path={proof.path} line={proof.line} onOpen={onOpen} />
    </span>
  );
}

/** A labelled line in an item: "Risk:", "Proof:", "Suggested fix:". */
function Labelled({
  label,
  children,
  tone = "text-zinc-400",
}: {
  label: string;
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <p className={`text-xs ${tone}`}>
      <span className="text-zinc-500">{label} </span>
      {children}
    </p>
  );
}

const APPROACH_CLASS: Record<VerificationApproach["rating"], string> = {
  "much-simpler": RISK_CLASS.high,
  simpler: RISK_CLASS.medium,
  "no-simpler": RISK_CLASS.low,
  unrated: "border-zinc-700 text-zinc-400",
};

/**
 * Opens a file of the PR at a line; the report's every location goes through
 * it. `canOpen` says whether a path is one of the PR's files: the report is
 * model-written, so a path it names is only a link when the PR has that file.
 */
export interface OpenLocation {
  open: (path: string, line?: number) => void;
  canOpen: (path: string) => boolean;
}

export function Location({
  path,
  line,
  onOpen,
  className = "text-[11px]",
  label,
}: {
  path?: string;
  line?: number;
  onOpen: OpenLocation;
  className?: string;
  /** What to show after the path; `:line` by default. */
  label?: string;
}) {
  if (!path) return null;
  const text = `${path}${label ?? (line ? `:${line}` : "")}`;
  if (!onOpen.canOpen(path)) {
    return <span className={`break-all font-mono text-zinc-400 ${className}`}>{text}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen.open(path, line)}
      className={`break-all font-mono text-sky-400 hover:text-sky-300 ${className}`}
    >
      {text}
    </button>
  );
}

const SEVERITY_RATINGS = ["low", "medium", "high"] as const;
const RISK_RATINGS = ["none", "low", "medium", "high"] as const;

/** A report section, with a line saying what it is for so a new reader knows what to judge. */
function Section({
  title,
  purpose,
  children,
}: {
  title: string;
  purpose: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h4>
        <p className="text-[11px] text-zinc-500">{purpose}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * The questions a review answers, in the order a reviewer asks them. Each
 * section of the report sits under the one it helps answer.
 */
const QUESTIONS = {
  intent: {
    title: "What is it trying to do?",
    purpose: "Read this first, so you know what you are reviewing and where to look.",
  },
  claims: {
    title: "Does it do what it claims?",
    purpose: "Each thing the PR says it does, and whether the code backs it.",
  },
  safety: {
    title: "Is it safe to ship?",
    purpose:
      "What could break, and whether tests, error handling or a guard show it won't. Accept a risk you're fine with, or post what's missing.",
  },
  unrelated: {
    title: "Anything malicious or unrelated?",
    purpose: "Code that does something hidden, or changes the PR's goal doesn't need.",
  },
  quality: {
    title: "Does it meet the quality bar?",
    purpose: "Design, readability and maintainability, once it is correct and safe.",
  },
} as const;

type Question = keyof typeof QUESTIONS;

/** Which question each check helps answer. */
const CHECK_QUESTION: Record<VerificationCheckKey, Question> = {
  malice: "unrelated",
  tests: "safety",
  performance: "safety",
  observability: "safety",
  complexity: "quality",
  comments: "quality",
  quality: "quality",
};

const CHECK_PURPOSE: Record<VerificationCheckKey, string> = {
  malice: "Hidden behaviour: backdoors, data sent out, weakened checks, tampered tests.",
  tests: "Whether the tests would catch a mistake in this change.",
  performance: "Slow paths, repeated work, or growth with no bound.",
  observability: "Whether a failure here would show up in logs or metrics.",
  complexity: "Code harder to follow than the problem needs.",
  comments: "Comments that are wrong, stale, or missing where the code can't explain itself.",
  quality: "Naming, duplication and structure that make the code harder to change.",
};

function QuestionGroup({ question, children }: { question: Question; children: React.ReactNode }) {
  const { title, purpose } = QUESTIONS[question];
  return (
    <section aria-label={title} className="space-y-3 border-t border-zinc-800 pt-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
        <p className="text-xs text-zinc-500">{purpose}</p>
      </div>
      {children}
    </section>
  );
}

/** Paths the reviewer has marked viewed. */
type Viewed = ReadonlySet<string>;

const NONE_VIEWED: Viewed = new Set();

const isViewed = (viewed: Viewed, path?: string) => !!path && viewed.has(path);

/** Struck through and dimmed once its file is viewed. */
const viewedClass = (done: boolean) => (done ? "line-through opacity-50" : "");

/** Says a layer stacked on this PR changes the finding's line, so it may be fixed there. */
function UpstackNote({
  upstack,
  path,
  line,
}: {
  upstack: VerificationUpstack | null;
  path?: string;
  line?: number;
}) {
  const layer = changedUpstack(upstack, path, line);
  if (!layer) return null;
  return (
    <button
      type="button"
      onClick={() => openExternal(layer.url)}
      title="A PR stacked on this one changes this line; it may already be fixed there."
      className="rounded border border-sky-800 px-1 py-0.5 text-[10px] text-sky-300 hover:bg-sky-950"
    >
      changed in #{layer.number} above
    </button>
  );
}

/**
 * A check passing is one line and nothing more: the reader's time goes to the
 * checks that found something, which open with their findings showing.
 */
function CheckRow({
  label,
  purpose,
  section,
  kind = "finding",
  check,
  onOpen,
  viewed,
  actions,
  upstack = null,
}: {
  label: string;
  /** What the check looks for; absent where the section already says. */
  purpose?: string;
  section: ReportSection;
  kind?: "finding" | "gap";
  check: VerificationCheck;
  onOpen: OpenLocation;
  viewed: Viewed;
  actions?: ReportActions;
  /** What the layers above change; only for a result at the PR's head, whose lines match theirs. */
  upstack?: VerificationUpstack | null;
}) {
  if (check.status === "pass" || check.findings.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="w-4 text-center text-emerald-400" aria-hidden="true">
          ✓
        </span>
        <span className="text-zinc-300">{label}</span>
        <span className="text-zinc-500">passes</span>
        {purpose && <span className="text-[11px] text-zinc-600">· {purpose}</span>}
      </div>
    );
  }
  return (
    <details open className="group text-sm">
      <summary className="flex cursor-pointer items-center gap-2">
        <span className="w-4 text-center text-amber-400" aria-hidden="true">
          !
        </span>
        <span className="text-zinc-200">{label}</span>
        <span className="text-zinc-500">
          {check.findings.length} {check.findings.length === 1 ? "finding" : "findings"}
        </span>
      </summary>
      {purpose && <p className="pl-6 text-[11px] text-zinc-500">{purpose}</p>}
      <ul className="mt-1 space-y-2 pl-5">
        {check.findings.map((f) => (
          <li
            key={`${f.title}:${f.path}:${f.line}`}
            className={`space-y-0.5 ${viewedClass(isViewed(viewed, f.path))}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded border px-1 py-0.5 text-[10px] uppercase ${SEVERITY_CLASS[f.severity]}`}
              >
                {f.severity}
              </span>
              <span className="font-medium text-zinc-200">{f.title}</span>
              <Location path={f.path} line={f.line} onOpen={onOpen} />
              <UpstackNote upstack={upstack} path={f.path} line={f.line} />
            </div>
            <p className="text-xs text-zinc-400">{f.detail}</p>
            <ReportItemActions
              section={section}
              sectionLabel={label}
              kind={kind}
              item={{ ...f, rating: f.severity }}
              actions={actions}
              ratings={SEVERITY_RATINGS}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}

const TRIPWIRE_LABEL: Record<VerificationTripwire["kind"], string> = {
  build: "Runs code or sets rules",
  binary: "Binary",
  "hidden-text": "Hidden text",
  "opaque-blob": "Encoded string",
  "test-tampering": "Tests",
};

/**
 * The places Yarvis's fixed rules flagged for the malicious-intent check.
 * Shown whatever the check made of them, since the point is that a model's
 * reading can't make one disappear.
 */
function Tripwires({
  tripwires,
  omitted,
  onOpen,
}: {
  tripwires: VerificationTripwire[];
  omitted: number;
  onOpen: OpenLocation;
}) {
  if (tripwires.length === 0) return null;
  return (
    <details className="pl-6 text-xs">
      <summary className="cursor-pointer text-zinc-400">
        {tripwires.length + omitted} {tripwires.length + omitted === 1 ? "tripwire" : "tripwires"}{" "}
        to confirm
      </summary>
      <ul className="mt-1 space-y-0.5">
        {tripwires.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two tripwires can share a kind, path and line
          <li key={i} className="flex flex-wrap items-center gap-2">
            <span className="text-zinc-500">{TRIPWIRE_LABEL[t.kind]}</span>
            <Location path={t.path} line={t.line} onOpen={onOpen} />
            <span className="text-zinc-400">{t.note}</span>
          </li>
        ))}
        {omitted > 0 && <li className="text-zinc-500">{omitted} more not listed.</li>}
      </ul>
    </details>
  );
}

type Theme = VerificationChangeMap["themes"][number];

/** What a theme's post says: the question for an outlier, else what the proofs leave uncovered. */
function themePostText(theme: Theme): string {
  if (theme.question) return theme.question;
  if (theme.unmitigated) {
    return [theme.riskWhy, `Not covered: ${theme.unmitigated}`].filter(Boolean).join("\n");
  }
  return theme.riskWhy || theme.description;
}

/**
 * Why a theme is risky and what shows the risk is handled. A report from
 * before themes carried proof has no `proofs`, so it says nothing either way
 * rather than "no proof found".
 */
function ThemeRiskDetail({ theme, onOpen }: { theme: Theme; onOpen: OpenLocation }) {
  if (theme.risk === "none" || theme.proofs === undefined) return null;
  return (
    <>
      {theme.riskWhy && <Labelled label="Risk:">{theme.riskWhy}</Labelled>}
      {theme.proofs.length > 0 ? (
        <div className="text-xs">
          <span
            {...explained("Proof it's handled", CLAIM_HELP)}
            className="cursor-help text-zinc-500"
          >
            Proof it's handled:
          </span>
          <ul className="ml-3 list-disc space-y-0.5 pl-2">
            {theme.proofs.map((p) => (
              <li key={`${p.text}:${p.path}:${p.line}`}>
                <EvidenceLine proof={p} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Labelled label="Proof it's handled:" tone="text-amber-300">
          None found
        </Labelled>
      )}
      {theme.unmitigated && (
        <Labelled label="Not covered:" tone="text-amber-200">
          {theme.unmitigated}
        </Labelled>
      )}
    </>
  );
}

/**
 * The change by theme, core first. An outlier carries the question for its
 * author, which can go to the PR like a finding, anchored at its first file.
 */
function ChangeMap({
  map,
  onOpen,
  viewed,
  actions,
}: {
  map: VerificationChangeMap;
  onOpen: OpenLocation;
  viewed: Viewed;
  actions?: ReportActions;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p className="text-zinc-200">{map.intent}</p>
      <ul className="space-y-2.5">
        {map.themes.map((theme) => {
          const first = theme.files[0];
          const done = theme.files.every((f) => isViewed(viewed, f.path));
          return (
            <li key={`${theme.title}:${first?.path}`} className="space-y-1">
              <div className={`flex flex-wrap items-center gap-2 ${viewedClass(done)}`}>
                <span
                  className={`rounded border px-1 py-0.5 text-[10px] uppercase ${COHESION_CLASS[theme.cohesion]}`}
                >
                  {COHESION_LABEL[theme.cohesion]}
                </span>
                <span
                  {...explained(THEME_RISK_LABEL[theme.risk], THEME_RISK_HELP)}
                  className={`cursor-help rounded border px-1 py-0.5 text-[10px] ${THEME_RISK_CLASS[theme.risk]}`}
                >
                  {THEME_RISK_LABEL[theme.risk]}
                </span>
                <span className="font-medium text-zinc-200">{theme.title}</span>
              </div>
              <Labelled label="Change:">{theme.description}</Labelled>
              <ThemeRiskDetail theme={theme} onOpen={onOpen} />
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {theme.files.map((f) => (
                  <Location
                    key={f.path}
                    path={f.path}
                    line={f.lines?.start}
                    label={f.lines ? `:${f.lines.start}-${f.lines.end}` : ""}
                    onOpen={onOpen}
                  />
                ))}
              </div>
              {/* The server keeps a question only on an outlier. */}
              {theme.question && first && (
                <div className="rounded border border-amber-900/60 bg-amber-950/20 p-2 text-xs">
                  <p className="text-amber-100">
                    <span className="text-amber-400">Ask the author: </span>
                    {theme.question}
                  </p>
                </div>
              )}
              <ReportItemActions
                section="changeMap"
                sectionLabel="Change map"
                kind="theme"
                item={{
                  title: theme.title,
                  detail: themePostText(theme),
                  rating: theme.risk,
                  path: first?.path,
                  line: first ? (first.lines?.start ?? 1) : undefined,
                }}
                lines={first?.lines}
                actions={actions}
                // Worth posting only when there is something to ask or add.
                canPost={!!theme.question || !!theme.unmitigated}
                risk={theme.risk !== "none"}
                ratings={RISK_RATINGS}
              />
            </li>
          );
        })}
      </ul>
      {map.unmapped.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
          <span>In no theme:</span>
          {map.unmapped.map((path) => (
            <Location key={path} path={path} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Each claim with its verdict and the code behind it, then the unfinished work no claim covers. */
function Claims({
  claims,
  onOpen,
  viewed,
  actions,
}: {
  claims: VerificationClaims;
  onOpen: OpenLocation;
  viewed: Viewed;
  actions?: ReportActions;
}) {
  const { tickets } = claims;
  return (
    <div className="space-y-2 text-sm">
      {tickets && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          {tickets.length === 0 ? (
            "Checked against the title and description; no tickets were read."
          ) : (
            <>
              Checked against the title, description and
              {tickets.map((t, i) => (
                <span key={t.key}>
                  <button
                    type="button"
                    title={t.title}
                    onClick={() => openExternal(t.url)}
                    className="text-sky-400 hover:text-sky-300"
                  >
                    {t.key}
                  </button>
                  {i < tickets.length - 1 && ","}
                </span>
              ))}
            </>
          )}
        </p>
      )}
      {claims.ticketNotes?.map((note) => (
        <p key={note} className="text-[11px] text-amber-300">
          {note}
        </p>
      ))}
      {claims.items.length === 0 ? (
        <p className="text-zinc-500">No claims to check.</p>
      ) : (
        <ul className="space-y-1.5">
          {claims.items.map((c) => (
            <li
              key={`${c.source}:${c.claim}:${c.path}:${c.line}`}
              className={`space-y-0.5 ${viewedClass(isViewed(viewed, c.path))}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded border px-1 py-0.5 text-[10px] uppercase ${CLAIM_CLASS[c.status]}`}
                >
                  {CLAIM_LABEL[c.status]}
                </span>
                <span className="text-zinc-200">{c.claim}</span>
                <span className="text-[11px] text-zinc-500">{c.source}</span>
                <Location path={c.path} line={c.line} onOpen={onOpen} />
              </div>
              <p className="text-xs text-zinc-400">{c.evidence}</p>
              <ReportItemActions
                section="claims"
                sectionLabel={`Claims: ${CLAIM_LABEL[c.status].toLowerCase()}`}
                kind="claim"
                item={{
                  title: c.claim,
                  detail: c.evidence,
                  rating: c.status,
                  path: c.path,
                  line: c.line,
                }}
                actions={actions}
                canPost={isUnmetClaim(c.status)}
              />
            </li>
          ))}
        </ul>
      )}
      {claims.gaps.length > 0 && (
        <CheckRow
          label="Unfinished work"
          section="claims"
          kind="gap"
          check={{ status: "issues", findings: claims.gaps }}
          onOpen={onOpen}
          viewed={viewed}
          actions={actions}
        />
      )}
    </div>
  );
}

/** The whole-PR rating: whether there is a simpler way, why, and what it is. */
function Approach({ approach, onOpen }: { approach: VerificationApproach; onOpen: OpenLocation }) {
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-start gap-2">
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${APPROACH_CLASS[approach.rating]}`}
        >
          {APPROACH_LABEL[approach.rating]}
        </span>
        <span className="text-zinc-300">{approach.reason}</span>
      </div>
      {approach.alternative && (
        <div className="text-xs text-zinc-400">
          <span className="text-zinc-500">Simpler way: </span>
          {approach.alternative}{" "}
          <Location path={approach.path} line={approach.line} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

/** Not-examined files shown before the rest fold away. */
const NOT_EXAMINED_SHOWN = 6;

/**
 * Which changed files the checks didn't read, first and hard to miss: nothing
 * below says anything about them. A report from before coverage was counted
 * says it can't tell, rather than implying it read everything.
 */
function Coverage({ report, onOpen }: { report: VerificationReport; onOpen: OpenLocation }) {
  const { coverage } = report;
  if (!coverage) {
    return (
      <p className="text-xs text-zinc-500">
        This report doesn't record which files its checks read. Re-run it to find out.
      </p>
    );
  }
  if (!coverageKnown(coverage)) {
    return (
      <p className="text-xs text-amber-300">
        Yarvis couldn't count which files the checks read, so this report may not cover every
        changed file.
      </p>
    );
  }
  const item = (entry: VerificationCoverage["notExamined"][number]) => (
    <li key={entry.path} className="text-sm">
      <Location path={entry.path} label="" className="text-xs" onOpen={onOpen} />
      <p className="text-xs text-amber-200/70">{entry.reason}</p>
    </li>
  );
  const shown = coverage.notExamined.slice(0, NOT_EXAMINED_SHOWN);
  const rest = coverage.notExamined.slice(NOT_EXAMINED_SHOWN);
  const skimmed = coverage.skimmed.length > 0 && (
    <details className="text-xs text-zinc-400">
      <summary className="cursor-pointer">
        Generated, skimmed: {files(coverage.skimmed.length)}
      </summary>
      <p className="mt-1 text-zinc-500">
        Lockfiles and generated, vendored or minified files. The checks read only their first page.
      </p>
      <ul className="mt-1 space-y-1">
        {coverage.skimmed.map((s) => (
          <li key={s.path}>
            <Location path={s.path} label="" className="text-xs" onOpen={onOpen} />{" "}
            <span className="text-zinc-500">({s.kind})</span>
          </li>
        ))}
      </ul>
    </details>
  );
  const gaps = coverage.laneGaps.length > 0 && (
    <ul className="space-y-1 text-xs text-zinc-400">
      {coverage.laneGaps.map((gap) => (
        <li key={gap.check}>
          Not examined by {gap.check}:{" "}
          {gap.paths.map((path, i) => (
            <span key={path}>
              {i > 0 && ", "}
              <Location path={path} label="" className="text-xs" onOpen={onOpen} />
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
  if (coverage.notExamined.length === 0) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-zinc-500">
          At least one check read each of the {files(coverage.examined)} to read
          {coverage.skimmed.length > 0 ? `, and skimmed ${files(coverage.skimmed.length)}` : ""}.
        </p>
        {gaps}
        {skimmed}
      </div>
    );
  }
  return (
    <section
      aria-label="Not examined"
      className="space-y-2 rounded-lg border border-amber-800 bg-amber-950/30 p-3"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-300">Not examined</h3>
      <p className="text-xs text-amber-200">
        No check read {coverage.notExamined.length} of the {files(coverage.total)} changed. Nothing
        in this report covers them; review them yourself.
      </p>
      <ul className="space-y-1.5">{shown.map(item)}</ul>
      {rest.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-amber-300">{rest.length} more</summary>
          <ul className="mt-1.5 space-y-1.5">{rest.map(item)}</ul>
        </details>
      )}
      {gaps}
      {skimmed}
    </section>
  );
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** Where a must-read's diff comes from: the review PR, at the head its lines are for. */
export interface DiffSource {
  workspaceId: string;
  pr: Pick<ReviewWorkspacePr, "id" | "headSha" | "mergeBaseSha">;
}

/** Most diff rows a snippet shows before sending the reader to the file. */
const SNIPPET_MAX_ROWS = 80;

/** The hunks of a must-read's diff that touch its lines, read through the review's diff cache. */
function SnippetRows({
  source,
  path,
  lines,
}: {
  source: DiffSource;
  path: string;
  lines?: { start: number; end: number };
}) {
  const diff = useReviewFileDiff(source.workspaceId, source.pr, path);
  const rows = useMemo(
    () => (diff.data && !diff.data.tooLarge ? rowsInRange(parsePatch(diff.data.patch), lines) : []),
    [diff.data, lines],
  );
  if (!diff.data) {
    return diff.error ? (
      <p className="mt-1 text-red-300">Couldn't load the diff.</p>
    ) : (
      <p className="mt-1 text-zinc-500">Loading…</p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="mt-1 text-zinc-500">
        {diff.data.tooLarge ? "The diff is too large to show here." : "No changes in these lines."}
      </p>
    );
  }
  return (
    <pre className="mt-1 max-h-80 overflow-auto rounded border border-zinc-800 bg-zinc-950 py-1 font-mono text-[11px] leading-snug">
      {rows.slice(0, SNIPPET_MAX_ROWS).map((r, i) => (
        // Rows have no id of their own, and their order is fixed once parsed.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={i} className={`whitespace-pre px-2 ${rowClass(r.kind)}`}>
          <span className="mr-2 inline-block w-8 select-none text-right text-zinc-600">
            {r.rightLine ?? ""}
          </span>
          {r.text}
        </div>
      ))}
      {rows.length > SNIPPET_MAX_ROWS && (
        <div className="px-2 text-zinc-500">
          {rows.length - SNIPPET_MAX_ROWS} more lines: open the file to read them.
        </div>
      )}
    </pre>
  );
}

/**
 * A must-read's part of the diff. Read only while open, so a closed report
 * loads nothing, and opening it again after a failure asks again.
 */
function DiffSnippet({
  source,
  path,
  lines,
}: {
  source: DiffSource;
  path: string;
  lines?: { start: number; end: number };
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="text-xs" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">Show the diff</summary>
      {open && <SnippetRows source={source} path={path} lines={lines} />}
    </details>
  );
}

/** A must-read and what already looks off or unclear in it. */
function MustReadItem({
  entry,
  onOpen,
  viewed,
  actions,
  diffSource,
}: {
  entry: VerificationMustRead;
  onOpen: OpenLocation;
  viewed: Viewed;
  actions?: ReportActions;
  /** Absent where the diff can't be read, or the must-reads are for an older head. */
  diffSource?: DiffSource;
}) {
  const flags = entry.flags ?? [];
  return (
    <li className={`text-sm ${viewedClass(isViewed(viewed, entry.path))}`}>
      <Location
        path={entry.path}
        line={entry.lines?.start}
        label={entry.lines ? `:${entry.lines.start}–${entry.lines.end}` : ""}
        className="text-xs"
        onOpen={onOpen}
      />
      <Labelled label="Answer while reading:" tone="text-zinc-300">
        {entry.reason}
      </Labelled>
      {entry.why && <Labelled label="Why it matters:">{entry.why}</Labelled>}
      {diffSource && <DiffSnippet source={diffSource} path={entry.path} lines={entry.lines} />}
      {/* Must-reads are written by the summary run, so their feedback is filed under it. */}
      <ReportItemActions
        section="summary"
        sectionLabel="Must read"
        kind="mustRead"
        item={{
          title: entry.reason,
          detail: entry.why ?? "",
          path: entry.path,
          line: entry.lines?.start,
        }}
        lines={entry.lines}
        actions={actions}
        canPost={false}
      />
      {flags.length > 0 && (
        <ul aria-label={FLAG_LABEL} className="mt-1 space-y-1.5 border-l border-amber-900/60 pl-2">
          {flags.map((flag, i) => (
            // The agent can repeat a note, so its position keeps the key unique.
            <li key={`${i}:${flag.note}`} className="space-y-0.5 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  title="Something in this file that already looks wrong or unclear: check it, then post it, reject it or ask about it."
                  className="rounded border border-amber-800 px-1 py-0.5 text-[10px] uppercase text-amber-300"
                >
                  {FLAG_LABEL}
                </span>
                <span className="text-amber-100">{flag.note}</span>
                {flag.line && <Location path={entry.path} line={flag.line} onOpen={onOpen} />}
              </div>
              <ReportItemActions
                section="summary"
                sectionLabel={FLAG_LABEL}
                kind="mustReadFlag"
                item={{
                  title: flag.note,
                  detail: entry.reason,
                  path: entry.path,
                  line: flag.line ?? entry.lines?.start,
                }}
                actions={actions}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

type Risk = NonNullable<VerificationReport["risk"]>;

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The mitigations that name this risk by its title. */
const mitigationsFor = (mitigations: readonly VerificationMitigation[], title: string) =>
  mitigations.filter((m) => m.addresses && sameTitle(m.addresses, title));

function MitigationList({
  mitigations,
  onOpen,
}: {
  mitigations: readonly VerificationMitigation[];
  onOpen: OpenLocation;
}) {
  if (mitigations.length === 0) return null;
  return (
    <div className="text-xs">
      <span {...explained("Limited by", CLAIM_HELP)} className="cursor-help text-zinc-500">
        Limited by:
      </span>
      <ul className="ml-3 list-disc space-y-0.5 pl-2">
        {mitigations.map((m) => (
          <li key={`${m.text}:${m.path}:${m.line}`}>
            <EvidenceLine proof={m} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A high concern is boxed, so the one that should block the merge isn't lost among the rest. */
const HIGH_CONCERN_CLASS = "rounded border border-red-900/70 bg-red-950/20 p-2";

/** What a concern's post says: what is wrong, then what to do about it. */
const concernPostText = (c: VerificationConcern) =>
  [c.detail, c.fix ? `Suggested fix: ${c.fix}` : ""].filter(Boolean).join("\n");

/** What an attention change's post says: what to confirm, then what to add to prove it. */
const changePostText = (c: VerificationChange) =>
  [c.check, c.fix ? `To prove it: ${c.fix}` : ""].filter(Boolean).join("\n");

/** The change map theme each path falls in, so scored changes can be read beside their theme. */
function themeOfPath(map: VerificationChangeMap | undefined): (path?: string) => string | null {
  const byPath = new Map<string, string>();
  for (const theme of map?.themes ?? []) {
    for (const f of theme.files) if (!byPath.has(f.path)) byPath.set(f.path, theme.title);
  }
  return (path) => {
    if (!path) return null;
    const exact = byPath.get(path);
    if (exact) return exact;
    // A folded change can name a folder.
    const folder = path.endsWith("/") ? path : `${path}/`;
    for (const [file, title] of byPath) if (file.startsWith(folder)) return title;
    return null;
  };
}

/**
 * The score: what the PR could break with nothing proven, and what is left
 * once its tests count. Older reports have only the second.
 */
function Score({ impact, level }: { impact?: VerificationImpact; level: Risk["level"] }) {
  if (!impact) {
    return (
      <span className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${RISK_CLASS[level]}`}>
        {level} risk
      </span>
    );
  }
  const potential = impact.potentialBand;
  const showsPotential = potential !== undefined && potential !== impact.band;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {showsPotential && (
        <>
          <span
            {...explained(
              `Potential ${potential}/5`,
              "The score if none of the PR's changes were proven by tests: how much could go wrong.",
            )}
            className={`cursor-help rounded border px-1.5 py-0.5 ${IMPACT_CLASS[potential]}`}
          >
            Potential {potential}/5
          </span>
          <span className="text-zinc-500" aria-hidden="true">
            →
          </span>
        </>
      )}
      <span
        {...explained(
          `Impact ${impact.band}/5`,
          showsPotential
            ? `${BAND_HELP} This counts the tests the PR has; other mitigations are listed under the risks they limit.`
            : BAND_HELP,
        )}
        className={`cursor-help rounded border px-1.5 py-0.5 ${IMPACT_CLASS[impact.band]}`}
      >
        {showsPotential ? "With its tests" : "Impact"} {impact.band}/5 · {IMPACT_LABEL[impact.band]}
      </span>
      {/* The level shows beside the band only when the agent judged it stricter. */}
      {level !== LEVEL_FOR_BAND[impact.band] && (
        <span
          {...explained(
            `${level} risk`,
            "The risk agent judged the PR riskier than its changes score, from something the score can't see, such as a failing CI check.",
          )}
          className={`cursor-help rounded border px-1.5 py-0.5 ${RISK_CLASS[level]}`}
        >
          {level} risk
        </span>
      )}
    </div>
  );
}

/**
 * The risk section: the score, the problems found with a fix for each, the
 * changes that need a reviewer's attention with their proof, and every scored
 * change grouped by the change map's themes. Each mitigation sits under the
 * risk it limits.
 */
function RiskDetail({
  risk,
  changeMap,
  onOpen,
  viewed,
  actions,
}: {
  risk: Risk;
  changeMap?: VerificationChangeMap;
  onOpen: OpenLocation;
  viewed: Viewed;
  actions?: ReportActions;
}) {
  const mitigations = risk.mitigations.map(asMitigation);
  const impact = risk.impact;
  const attention = impact?.changes.filter((c) => c.band >= ATTENTION_BAND) ?? [];
  const titles = [...risk.concerns.map((c) => c.title), ...attention.map((c) => c.title)];
  const unplaced = mitigations.filter(
    (m) => !m.addresses || !titles.some((t) => sameTitle(t, m.addresses)),
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1">
        <Score impact={impact} level={risk.level} />
        {risk.clientImpact && (
          <Labelled label="If it's wrong, users see:" tone="text-zinc-300">
            {risk.clientImpact}
          </Labelled>
        )}
        {impact && (
          <p className="text-[11px] text-zinc-500">
            {countsText(impact.counts)}
            {impact.raisedByVolume > 0 &&
              ` · raised from ${IMPACT_LABEL[impact.highestChangeBand]} by the number of changes, so splitting the PR would lower it`}
          </p>
        )}
      </div>

      {risk.concerns.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs text-zinc-500">Problems found</div>
          <ul className="space-y-2">
            {risk.concerns.map((c) => (
              <li
                key={`${c.title}:${c.path}:${c.line}`}
                className={`space-y-0.5 ${c.severity === "high" ? HIGH_CONCERN_CLASS : ""} ${viewedClass(isViewed(viewed, c.path))}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {c.severity && (
                    <span
                      className={`rounded border px-1 py-0.5 text-[10px] uppercase ${SEVERITY_CLASS[c.severity]}`}
                    >
                      {c.severity}
                    </span>
                  )}
                  <span className="font-medium text-zinc-200">{c.title}</span>
                  <Location path={c.path} line={c.line} onOpen={onOpen} />
                </div>
                <p className="text-xs text-zinc-400">{c.detail}</p>
                {c.fix && (
                  <Labelled label="Suggested fix:" tone="text-sky-200/90">
                    {c.fix}
                  </Labelled>
                )}
                <MitigationList
                  mitigations={mitigationsFor(mitigations, c.title)}
                  onOpen={onOpen}
                />
                <ReportItemActions
                  section="risk"
                  sectionLabel="Risk"
                  kind="concern"
                  item={{
                    title: c.title,
                    detail: concernPostText(c),
                    rating: c.severity,
                    path: c.path,
                    line: c.line,
                  }}
                  actions={actions}
                  risk
                  ratings={SEVERITY_RATINGS}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {attention.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs text-zinc-500">
            Changes that need your attention · scored 4 or 5, where a mistake would spread furthest
          </div>
          <ul className="space-y-2">
            {attention.map((c, i) => (
              <li
                // Folded entries can share a title and have no location, so the position keeps keys unique.
                key={`${i}:${c.title}`}
                className={`space-y-0.5 ${viewedClass(isViewed(viewed, c.path))}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-200">{c.title}</span>
                  <Location path={c.path} line={c.line} onOpen={onOpen} />
                </div>
                <ChangeTraits change={c} />
                {c.check && <Labelled label="Confirm:">{c.check}</Labelled>}
                {c.proof ? (
                  <div className="text-xs">
                    <span {...explained("Proof", CLAIM_HELP)} className="cursor-help text-zinc-500">
                      Proof:{" "}
                    </span>
                    <EvidenceLine proof={c.proof} onOpen={onOpen} />
                  </div>
                ) : null}
                {c.fix && (
                  <Labelled label="To prove it:" tone="text-sky-200/90">
                    {c.fix}
                  </Labelled>
                )}
                <MitigationList
                  mitigations={mitigationsFor(mitigations, c.title)}
                  onOpen={onOpen}
                />
                <ReportItemActions
                  section="risk"
                  sectionLabel="Impact"
                  kind="change"
                  item={{
                    title: c.title,
                    detail: changePostText(c),
                    rating: `${c.band}/5`,
                    path: c.path,
                    line: c.line,
                  }}
                  actions={actions}
                  // Worth posting only when it says what to add.
                  canPost={!!c.fix}
                  risk
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {unplaced.length > 0 && (
        <div className="text-xs">
          <span className="text-zinc-500">Other mitigations in the PR:</span>
          <ul className="ml-3 list-disc space-y-0.5 pl-2">
            {unplaced.map((m) => (
              <li key={`${m.text}:${m.path}:${m.line}`}>
                <EvidenceLine proof={m} onOpen={onOpen} />
                {m.addresses && <span className="text-zinc-500"> (limits: {m.addresses})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {impact && <EveryChange impact={impact} changeMap={changeMap} onOpen={onOpen} />}
    </div>
  );
}

/** Every scored change, under the change map theme its file belongs to. */
function EveryChange({
  impact,
  changeMap,
  onOpen,
}: {
  impact: VerificationImpact;
  changeMap?: VerificationChangeMap;
  onOpen: OpenLocation;
}) {
  // Without a change map there are no themes, so one untitled group holds every change.
  const groups = new Map<string | null, VerificationChange[]>();
  const themeOf = themeOfPath(changeMap);
  for (const c of impact.changes) {
    const theme = changeMap ? (themeOf(c.path) ?? "In no theme") : null;
    const group = groups.get(theme);
    if (group) group.push(c);
    else groups.set(theme, [c]);
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-zinc-500">
        Every scored change ({impact.changes.length})
      </summary>
      <p className="mt-1 text-[11px] text-zinc-500">
        Each change is scored 1 to 5 for how far a mistake in it could spread. Hover a label to see
        what it means. {changeMap && "Grouped by the change map's themes."}
      </p>
      <div className="mt-1.5 space-y-2">
        {[...groups].map(([theme, changes]) => (
          <div key={theme ?? ""} className="space-y-1">
            {theme && <div className="text-zinc-400">{theme}</div>}
            <ul className="space-y-1">
              {changes.map((c, i) => (
                <li key={`${i}:${c.title}`} className="flex flex-wrap items-center gap-2">
                  <span className="text-zinc-300">{c.title}</span>
                  <Location path={c.path} line={c.line} onOpen={onOpen} />
                  <ChangeTraits change={c} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * The report grouped by the questions a review answers: what the PR is for,
 * whether it does what it says, whether it is safe to ship, whether anything
 * is hidden or unrelated, and whether it meets the quality bar. Which files
 * the checks didn't read comes first, since it bounds everything below.
 */
export default function VerificationReportView({
  report,
  onOpen,
  viewed = NONE_VIEWED,
  actions,
  currentSections,
  upstack = null,
  diffSource,
}: {
  report: VerificationReport;
  onOpen: OpenLocation;
  viewed?: Viewed;
  /** What the PRs stacked on this one change in it, read at the PR's head. */
  upstack?: VerificationUpstack | null;
  /** Absent where items can't be sent anywhere or judged. */
  actions?: ReportActions;
  /**
   * The sections whose result is for the PR's head now; absent when they all
   * are. The others are marked, and their findings can't be posted or asked
   * about, since their line numbers may point at different code now. They
   * can still be judged.
   */
  currentSections?: ReadonlySet<string>;
  /** Where a must-read's diff snippet is read from. */
  diffSource?: DiffSource;
}) {
  const { risk } = report;
  const isCurrent = (section: string) => !currentSections || currentSections.has(section);
  const actionsFor = (section: string): ReportActions | undefined =>
    actions && (isCurrent(section) ? actions : { feedback: actions.feedback });
  const titled = (title: string, section: string) =>
    isCurrent(section) ? title : `${title} · older head`;
  const mustReadViewed = report.mustRead.filter((entry) => isViewed(viewed, entry.path)).length;
  const outliers = report.changeMap?.themes.filter((t) => t.cohesion === "outlier") ?? [];
  const checksFor = (question: Question) =>
    VERIFICATION_CHECKS.filter((key) => CHECK_QUESTION[key] === question && report[key]);

  const checkRows = (question: Question) =>
    checksFor(question).map((key) => {
      // Filtered to present checks above.
      const check = report[key] as VerificationCheck;
      return (
        <div key={key} className="space-y-1">
          <CheckRow
            label={titled(CHECK_LABEL[key], key)}
            purpose={CHECK_PURPOSE[key]}
            section={key}
            check={check}
            onOpen={onOpen}
            viewed={viewed}
            actions={actionsFor(key)}
            upstack={isCurrent(key) ? upstack : null}
          />
          {key === "malice" && report.malice?.tripwires && (
            <Tripwires
              tripwires={report.malice.tripwires}
              omitted={report.malice.tripwiresOmitted ?? 0}
              onOpen={onOpen}
            />
          )}
        </div>
      );
    });

  const hasIntent =
    report.summary !== undefined || report.mustRead.length > 0 || !!report.changeMap;
  const hasSafety = !!risk || checksFor("safety").length > 0;
  const hasUnrelated = outliers.length > 0 || checksFor("unrelated").length > 0;
  const hasQuality = !!report.approach || checksFor("quality").length > 0;

  return (
    <div className="space-y-5">
      <Coverage report={report} onOpen={onOpen} />

      {hasIntent && (
        <QuestionGroup question="intent">
          {report.summary !== undefined && (
            <Section title={titled("Summary", "summary")} purpose="What the PR changes, in brief.">
              <p className="text-sm leading-relaxed text-zinc-200">{report.summary}</p>
              <ReportItemActions
                section="summary"
                sectionLabel="Summary"
                kind="summary"
                item={{ title: "Summary", detail: report.summary }}
                actions={actionsFor("summary")}
                canPost={false}
              />
            </Section>
          )}

          {report.mustRead.length > 0 && (
            <Section
              title={titled(
                `Must read · ${mustReadViewed} of ${report.mustRead.length} viewed`,
                "summary",
              )}
              purpose="The files where your reading can change the outcome. Each has a question to answer as you read it, and why a wrong answer matters."
            >
              <ul className="space-y-2.5">
                {report.mustRead.map((entry) => (
                  <MustReadItem
                    key={entry.path}
                    entry={entry}
                    onOpen={onOpen}
                    viewed={viewed}
                    actions={actionsFor("summary")}
                    // The diff is read at the current head, so it matches only current must-reads.
                    diffSource={isCurrent("summary") ? diffSource : undefined}
                  />
                ))}
              </ul>
            </Section>
          )}

          {report.changeMap && (
            <Section
              title={titled("Change map", "changeMap")}
              purpose="The changes grouped by reason. Each says what could go wrong and what in the PR shows it's handled: accept the risk, or reject the theme's rating and say why."
            >
              <ChangeMap
                map={report.changeMap}
                onOpen={onOpen}
                viewed={viewed}
                actions={actionsFor("changeMap")}
              />
            </Section>
          )}
        </QuestionGroup>
      )}

      {report.claims && (
        <QuestionGroup question="claims">
          <Section
            title={titled("Claims", "claims")}
            purpose="What the title, description and tickets say, each checked against the code, then unfinished work no claim covers."
          >
            <Claims
              claims={report.claims}
              onOpen={onOpen}
              viewed={viewed}
              actions={actionsFor("claims")}
            />
          </Section>
        </QuestionGroup>
      )}

      {hasSafety && (
        <QuestionGroup question="safety">
          {risk && (
            <Section
              title={titled("Risk", "risk")}
              purpose="How far a mistake could spread, before and after the PR's tests; the problems found, each with a fix; and what limits each risk."
            >
              <RiskDetail
                risk={risk}
                changeMap={report.changeMap}
                onOpen={onOpen}
                viewed={viewed}
                actions={actionsFor("risk")}
              />
            </Section>
          )}
          {checksFor("safety").length > 0 && <div className="space-y-2">{checkRows("safety")}</div>}
        </QuestionGroup>
      )}

      {hasUnrelated && (
        <QuestionGroup question="unrelated">
          {checkRows("unrelated")}
          {outliers.length > 0 && (
            <Section
              title={titled("Unrelated changes", "changeMap")}
              purpose="Themes from the change map that the PR's goal doesn't need. Judge or post each one there."
            >
              <ul className="space-y-1 text-xs">
                {outliers.map((t) => (
                  <li key={t.title}>
                    <span className="text-amber-200">{t.title}</span>
                    {t.question && <span className="text-zinc-400"> · {t.question}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </QuestionGroup>
      )}

      {hasQuality && (
        <QuestionGroup question="quality">
          {report.approach && (
            <Section
              title={titled("Simpler approach", "approach")}
              purpose="Whether a materially simpler design reaches the same goal."
            >
              <Approach approach={report.approach} onOpen={onOpen} />
              <ReportItemActions
                section="approach"
                sectionLabel="Simpler approach"
                kind="approach"
                item={{
                  title: APPROACH_LABEL[report.approach.rating],
                  detail: [report.approach.reason, report.approach.alternative]
                    .filter(Boolean)
                    .join(" "),
                  path: report.approach.path,
                  line: report.approach.line,
                }}
                actions={actionsFor("approach")}
                canPost={
                  report.approach.rating === "simpler" || report.approach.rating === "much-simpler"
                }
              />
            </Section>
          )}
          {checksFor("quality").length > 0 && (
            <div className="space-y-2">{checkRows("quality")}</div>
          )}
        </QuestionGroup>
      )}
    </div>
  );
}
