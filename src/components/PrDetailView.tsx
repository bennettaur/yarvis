import type { ReactNode } from "react";
import { usePrDetail } from "../lib/pr/cache";
import { refDisplayRepo, refNumber, refProviderName } from "../lib/pr/ref";
import type { CheckItem, PrSummary } from "../lib/pr/types";
import { openExternal } from "../lib/url";
import PrChecks from "./pr/PrChecks";
import PrDescription from "./pr/PrDescription";
import PrFileDiffs from "./pr/PrFileDiffs";
import PrFileList from "./pr/PrFileList";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

/** Short "2 passing · 1 failing" summary so the collapsed Checks header still reads. */
function checksSummary(checks: CheckItem[]): string {
  let passing = 0;
  let failing = 0;
  let pending = 0;
  for (const c of checks) {
    if (c.status !== "COMPLETED") pending++;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes((c.conclusion ?? "").toUpperCase()))
      passing++;
    else failing++;
  }
  const parts: string[] = [];
  if (passing) parts.push(`${passing} passing`);
  if (failing) parts.push(`${failing} failing`);
  if (pending) parts.push(`${pending} pending`);
  return parts.join(" · ");
}

/** Collapsible section header; defaults open, mirroring the file-diff idiom. */
function CollapsibleSection({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details open className="group">
      <summary className="mb-2 flex cursor-pointer items-center gap-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        <span className="text-zinc-600 group-open:rotate-90 transition-transform">▶</span>
        {title}
        {summary && <span className="font-normal normal-case text-zinc-600">· {summary}</span>}
      </summary>
      {children}
    </details>
  );
}

/**
 * Full in-app PR review: header plus the decomposed description, checks, and a
 * changed-file list beside the file diffs. The pieces share one fetch through
 * the PR cache (keyed by the ref), so naming the same PR here and in each child
 * does not multiply requests.
 */
export default function PrDetailView({ pr, onBack }: { pr: PrSummary; onBack: () => void }) {
  const prRef = pr.ref;
  const { data: detail, error } = usePrDetail(prRef);

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
          Open on {refProviderName(prRef)}
        </button>
      </div>

      <header>
        <h2 className="text-lg font-semibold text-zinc-100">
          {pr.title}
          <span className="ml-2 font-normal text-zinc-500">#{refNumber(prRef)}</span>
        </h2>
        <div className="mt-1 text-xs text-zinc-500">
          {refDisplayRepo(prRef)} · {detail?.author ?? pr.author}
          {detail && (
            <>
              {" · "}
              <span className="font-mono">
                {detail.baseRef} ← {detail.headRef}
              </span>
              {detail.additions + detail.deletions > 0 && (
                <>
                  {" · "}
                  <span className="text-emerald-400">+{detail.additions}</span>{" "}
                  <span className="text-red-400">−{detail.deletions}</span>
                </>
              )}
            </>
          )}
        </div>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <PrDescription prRef={prRef} />

      <CollapsibleSection
        title="Checks"
        summary={detail ? checksSummary(detail.checks) : undefined}
      >
        <PrChecks prRef={prRef} />
      </CollapsibleSection>

      <Section title="Files">
        <div className="flex gap-4">
          <div className="sticky top-0 max-h-[80vh] w-64 shrink-0 self-start overflow-auto">
            <PrFileList prRef={prRef} />
          </div>
          <div className="min-w-0 flex-1">
            <PrFileDiffs prRef={prRef} />
          </div>
        </div>
      </Section>
    </div>
  );
}
