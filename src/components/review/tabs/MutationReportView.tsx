import type {
  MutantOutcome,
  MutantResult,
  MutationFinding,
  MutationSummary,
  MutationVerdict,
} from "../../../lib/reviewWorkspaces/mutation";
import type { OpenLocation } from "./VerificationReportView";

/**
 * A mutation-testing pass's results. Everything in a result that came from
 * the PR, its tests or a model is untrusted, so it is shown as plain text in
 * `<pre>` and spans — never as markdown — and a path is only a link when it is
 * one of the PR's files.
 */

const VERDICT: Record<MutationVerdict, { label: string; className: string; says: string }> = {
  strong: {
    label: "Strong",
    className: "border-emerald-700 text-emerald-300",
    says: "The tests caught nearly every change to the code this PR touches.",
  },
  mixed: {
    label: "Mixed",
    className: "border-amber-700 text-amber-300",
    says: "The tests caught most changes, but some got through.",
  },
  weak: {
    label: "Weak",
    className: "border-red-800 text-red-300",
    says: "Many changes to this code went unnoticed by the tests.",
  },
  inconclusive: {
    label: "Inconclusive",
    className: "border-zinc-700 text-zinc-300",
    says: "Too few mutants gave a result to judge the tests.",
  },
};

export const OUTCOME_CLASS: Record<MutantOutcome, string> = {
  killed: "text-emerald-400",
  timeout: "text-emerald-400",
  survived: "text-red-400",
  error: "text-zinc-500",
  uncovered: "text-amber-400",
  equivalent: "text-zinc-500",
};

function Location({ path, line, onOpen }: { path: string; line: number; onOpen: OpenLocation }) {
  const text = `${path}:${line}`;
  if (!onOpen.canOpen(path)) {
    return <span className="break-all font-mono text-[11px] text-zinc-400">{text}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen.open(path, line)}
      className="break-all font-mono text-[11px] text-sky-400 hover:text-sky-300"
    >
      {text}
    </button>
  );
}

/** The mutant's edit as a two-line diff. */
export function MutantDiff({ mutant }: { mutant: Pick<MutantResult, "oldText" | "newText"> }) {
  return (
    <pre className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed">
      <span className="block text-red-300">- {mutant.oldText}</span>
      <span className="block text-emerald-300">+ {mutant.newText}</span>
    </pre>
  );
}

function Survivor({
  mutant,
  finding,
  onOpen,
}: {
  mutant: MutantResult;
  finding: MutationFinding | undefined;
  onOpen: OpenLocation;
}) {
  const tests =
    mutant.testFiles.length > 0 ? mutant.testFiles.join(", ") : (mutant.testCommandId ?? null);
  return (
    <li className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {finding && (
          <span className="rounded border border-zinc-700 px-1 py-0.5 text-[10px] uppercase text-zinc-300">
            {finding.severity}
          </span>
        )}
        <span className="text-sm font-medium text-zinc-200">
          {finding?.title ?? mutant.description}
        </span>
        <Location path={mutant.path} line={mutant.line} onOpen={onOpen} />
      </div>
      <MutantDiff mutant={mutant} />
      {finding?.detail && <p className="text-xs text-zinc-400">{finding.detail}</p>}
      {tests && (
        <p className="text-xs text-zinc-400">
          <span className="text-zinc-500">Should have been caught by: </span>
          <span className="font-mono text-zinc-300">{tests}</span>
        </p>
      )}
      {finding?.suggestion && (
        <div>
          <div className="mb-1 text-xs text-zinc-500">Suggested assertion</div>
          <pre className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-200">
            {finding.suggestion}
          </pre>
        </div>
      )}
      {mutant.evidence && (
        <details>
          <summary className="cursor-pointer text-xs text-zinc-500">Test output</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-400">
            {mutant.evidence}
          </pre>
        </details>
      )}
    </li>
  );
}

function OtherOutcomes({
  label,
  mutants,
  onOpen,
}: {
  label: string;
  mutants: MutantResult[];
  onOpen: OpenLocation;
}) {
  if (mutants.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-zinc-300">
        {label} <span className="text-zinc-500">{mutants.length}</span>
      </summary>
      <ul className="mt-1 space-y-1.5 pl-4">
        {mutants.map((m) => (
          <li key={m.id} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-zinc-300">{m.description}</span>
              <Location path={m.path} line={m.line} onOpen={onOpen} />
            </div>
            {m.outcome === "error" && m.evidence && (
              <p className="whitespace-pre-wrap text-[11px] text-zinc-500">
                {m.evidence.slice(0, 300)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function killRateText(summary: MutationSummary): string {
  const caught = summary.killed + summary.timeouts;
  if (summary.valid === 0) return "No mutant gave a result.";
  return `The tests caught ${caught} of ${summary.valid} mutants (${Math.round(
    (summary.killRate ?? 0) * 100,
  )}%).`;
}

/** Verdict first, then each survivor as a finding, then the rest folded away. */
export default function MutationReportView({
  summary,
  mutants,
  findings,
  onOpen,
}: {
  summary: MutationSummary;
  mutants: MutantResult[];
  findings: MutationFinding[];
  onOpen: OpenLocation;
}) {
  const verdict = VERDICT[summary.verdict];
  const byMutant = new Map(findings.map((f) => [f.mutantId, f]));
  const byOutcome = (outcomes: MutantOutcome[]) =>
    mutants.filter((m) => outcomes.includes(m.outcome));
  const survivors = byOutcome(["survived"]);
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded border px-2 py-0.5 text-sm font-medium ${verdict.className}`}>
            {verdict.label}
          </span>
          <span className="text-sm text-zinc-200">{killRateText(summary)}</span>
        </div>
        <p className="text-xs text-zinc-400">{verdict.says}</p>
        {summary.notes.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-500">
            {summary.notes.map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the notes are fixed for a pass and may repeat
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </section>

      {survivors.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Survived {survivors.length}
          </h3>
          <ul className="space-y-3">
            {survivors.map((m) => (
              <Survivor key={m.id} mutant={m} finding={byMutant.get(m.id)} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-1">
        <OtherOutcomes label="Caught" mutants={byOutcome(["killed", "timeout"])} onOpen={onOpen} />
        <OtherOutcomes label="No test reaches" mutants={byOutcome(["uncovered"])} onOpen={onOpen} />
        <OtherOutcomes
          label="Equivalent (skipped)"
          mutants={byOutcome(["equivalent"])}
          onOpen={onOpen}
        />
        <OtherOutcomes label="Proved nothing" mutants={byOutcome(["error"])} onOpen={onOpen} />
      </section>
    </div>
  );
}
