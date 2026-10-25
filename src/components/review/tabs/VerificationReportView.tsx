import {
  type Severity,
  VERIFICATION_CHECKS,
  type VerificationCheck,
  type VerificationCheckKey,
  type VerificationCoverage,
  type VerificationReport,
} from "../../../lib/reviewWorkspaces/verification";

export const CHECK_LABEL: Record<VerificationCheckKey, string> = {
  completeness: "Completeness",
  tests: "Test quality",
  complexity: "Complexity",
  performance: "Performance",
  comments: "Comment quality",
};

const SEVERITY_CLASS: Record<Severity, string> = {
  high: "border-red-800 text-red-300",
  medium: "border-amber-800 text-amber-300",
  low: "border-zinc-700 text-zinc-400",
};

const RISK_CLASS: Record<VerificationReport["risk"]["level"], string> = {
  high: "border-red-700 bg-red-950/40 text-red-300",
  medium: "border-amber-700 bg-amber-950/40 text-amber-300",
  low: "border-emerald-800 bg-emerald-950/30 text-emerald-300",
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

function Location({
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A check passing is one line and nothing more: the reader's time goes to the
 * checks that found something, which open with their findings showing.
 */
function CheckRow({
  label,
  check,
  onOpen,
}: {
  label: string;
  check: VerificationCheck;
  onOpen: OpenLocation;
}) {
  if (check.status === "pass" || check.findings.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="w-4 text-center text-emerald-400" aria-hidden="true">
          ✓
        </span>
        <span className="text-zinc-300">{label}</span>
        <span className="text-zinc-500">passes</span>
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
      <ul className="mt-1 space-y-2 pl-5">
        {check.findings.map((f) => (
          <li key={`${f.title}:${f.path}:${f.line}`} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded border px-1 py-0.5 text-[10px] uppercase ${SEVERITY_CLASS[f.severity]}`}
              >
                {f.severity}
              </span>
              <span className="font-medium text-zinc-200">{f.title}</span>
              <Location path={f.path} line={f.line} onOpen={onOpen} />
            </div>
            <p className="text-xs text-zinc-400">{f.detail}</p>
          </li>
        ))}
      </ul>
    </details>
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
  if (coverage.notExamined.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        The checks read all {coverage.total} changed {coverage.total === 1 ? "file" : "files"}.
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
  return (
    <section
      aria-label="Not examined"
      className="space-y-2 rounded-lg border border-amber-800 bg-amber-950/30 p-3"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-300">Not examined</h3>
      <p className="text-xs text-amber-200">
        The checks didn't read {coverage.notExamined.length} of the {coverage.total} changed files.
        Nothing in this report covers them; review them yourself.
      </p>
      <ul className="space-y-1.5">{shown.map(item)}</ul>
      {rest.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-amber-300">{rest.length} more</summary>
          <ul className="mt-1.5 space-y-1.5">{rest.map(item)}</ul>
        </details>
      )}
    </section>
  );
}

/**
 * The report in the order a reviewer uses it: which files it didn't cover,
 * what the change is, which files to read first, how risky it is, then the
 * checks.
 */
export default function VerificationReportView({
  report,
  onOpen,
}: {
  report: VerificationReport;
  onOpen: OpenLocation;
}) {
  const { risk } = report;
  return (
    <div className="space-y-5">
      <Coverage report={report} onOpen={onOpen} />

      <Section title="Summary">
        <p className="text-sm leading-relaxed text-zinc-200">{report.summary}</p>
      </Section>

      {report.mustRead.length > 0 && (
        <Section title="Must read">
          <ul className="space-y-1.5">
            {report.mustRead.map((entry) => (
              <li key={entry.path} className="text-sm">
                <Location
                  path={entry.path}
                  line={entry.lines?.start}
                  label={entry.lines ? `:${entry.lines.start}–${entry.lines.end}` : ""}
                  className="text-xs"
                  onOpen={onOpen}
                />
                <p className="text-xs text-zinc-400">{entry.reason}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Risk">
        <div className="space-y-2 text-sm">
          <div className="flex items-start gap-2">
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${RISK_CLASS[risk.level]}`}
            >
              {risk.level} risk
            </span>
            <span className="text-zinc-300">{risk.clientImpact}</span>
          </div>
          {risk.mitigations.length > 0 && (
            <div className="text-xs text-zinc-400">
              <span className="text-zinc-500">Mitigations: </span>
              {risk.mitigations.join(" · ")}
            </div>
          )}
          {risk.concerns.length > 0 && (
            <ul className="space-y-1.5">
              {risk.concerns.map((c) => (
                <li key={`${c.title}:${c.path}:${c.line}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-zinc-200">{c.title}</span>
                    <Location path={c.path} line={c.line} onOpen={onOpen} />
                  </div>
                  <p className="text-xs text-zinc-400">{c.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section title="Checks">
        <div className="space-y-2">
          {VERIFICATION_CHECKS.map((key) => (
            <CheckRow key={key} label={CHECK_LABEL[key]} check={report[key]} onOpen={onOpen} />
          ))}
        </div>
      </Section>
    </div>
  );
}
