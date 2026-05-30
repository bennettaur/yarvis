import { useEffect, type ReactNode } from "react";
import { usePrDetail } from "../lib/githubCache";
import { recordEvent } from "../lib/events";
import { type PrSummary } from "../lib/github";
import { openExternal } from "../lib/url";
import PrChecks from "./pr/PrChecks";
import PrDescription from "./pr/PrDescription";
import PrFileDiffs from "./pr/PrFileDiffs";
import PrFileList from "./pr/PrFileList";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Full in-app PR review: header plus the decomposed description, checks, and a
 * changed-file list beside the file diffs. The pieces share one fetch through
 * the github cache (keyed by owner/repo/number), so naming the same PR here and
 * in each child does not multiply requests.
 */
export default function PrDetailView({
  pr,
  onBack,
}: {
  pr: PrSummary;
  onBack: () => void;
}) {
  const ref = { owner: pr.owner, repo: pr.repo, number: pr.number };
  const { data: detail, error } = usePrDetail(pr.owner, pr.repo, pr.number);

  // Record opening a PR for review. Keyed strictly by PR identity so re-renders
  // (and metadata edits like a rename) don't re-fire; a different PR records a
  // new event. Fire-and-forget.
  useEffect(() => {
    void recordEvent(
      "pr.viewed",
      { owner: pr.owner, repo: pr.repo, number: pr.number, title: pr.title, url: pr.url },
      "github",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.owner, pr.repo, pr.number]);

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
          Open on GitHub
        </button>
      </div>

      <header>
        <h2 className="text-lg font-semibold text-zinc-100">
          {pr.title}
          <span className="ml-2 font-normal text-zinc-500">#{pr.number}</span>
        </h2>
        <div className="mt-1 text-xs text-zinc-500">
          {pr.owner}/{pr.repo} · {detail?.author ?? pr.author}
          {detail && (
            <>
              {" · "}
              <span className="font-mono">
                {detail.baseRef} ← {detail.headRef}
              </span>
              {" · "}
              <span className="text-emerald-400">+{detail.additions}</span>{" "}
              <span className="text-red-400">−{detail.deletions}</span>
            </>
          )}
        </div>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <PrDescription {...ref} />

      <Section title="Checks">
        <PrChecks {...ref} />
      </Section>

      <Section title="Files">
        <div className="flex gap-4">
          <div className="sticky top-0 max-h-[80vh] w-64 shrink-0 self-start overflow-auto">
            <PrFileList {...ref} />
          </div>
          <div className="min-w-0 flex-1">
            <PrFileDiffs {...ref} />
          </div>
        </div>
      </Section>
    </div>
  );
}
