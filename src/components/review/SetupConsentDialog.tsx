import { useCallback, useEffect, useRef, useState } from "react";
import { usePrDetail } from "../../lib/pr/cache";
import { refDisplayRepo, refNumber } from "../../lib/pr/ref";
import {
  answerReviewSetup,
  type ReviewSetupInfo,
  type ReviewWorkspacePr,
  reviewSetupInfo,
} from "../../lib/reviewWorkspaces/api";

/** The answer to send: exactly the script and commit the prompt showed. */
export function consentAnswer(info: ReviewSetupInfo, grant: boolean) {
  return { grant, script: info.script, headSha: info.headSha };
}

/** Said when the sidecar refused an answer because what it would run has moved. */
export const MOVED_NOTICE =
  "The setup script or the PR's head changed since this opened. Check what would run now before answering.";

const statusOf = (e: unknown) =>
  e && typeof e === "object" && "status" in e ? (e as { status: unknown }).status : null;

/**
 * Asks once per PR before running its repo's setup script in the checkout.
 * The prompt shows whose code it is, which commit, and the script exactly as
 * it will run. What was shown is what is sent back: the sidecar refuses the
 * answer if the script or the PR's head moved in between, and the prompt then
 * reloads so the reader sees what would run now.
 */
export default function SetupConsentDialog({
  workspaceId,
  pr,
  onClose,
  onAnswered,
}: {
  workspaceId: string;
  pr: ReviewWorkspacePr;
  onClose: () => void;
  onAnswered: (pr: ReviewWorkspacePr) => void;
}) {
  const [info, setInfo] = useState<ReviewSetupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fromFork = usePrDetail(pr.ref).data?.fromFork ?? false;

  const load = useCallback(async () => {
    setInfo(null);
    setInfo(await reviewSetupInfo(workspaceId, pr.id));
  }, [workspaceId, pr.id]);

  useEffect(() => {
    let live = true;
    reviewSetupInfo(workspaceId, pr.id)
      .then((i) => live && setInfo(i))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, pr.id]);

  const answer = async (grant: boolean) => {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      onAnswered(await answerReviewSetup(workspaceId, pr.id, consentAnswer(info, grant)));
    } catch (e) {
      if (statusOf(e) === 409) {
        setError(MOVED_NOTICE);
        await load().catch((le) => setError(le instanceof Error ? le.message : String(le)));
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    }
  };

  return (
    <SetupConsentView
      pr={pr}
      info={info}
      fromFork={fromFork}
      error={error}
      busy={busy}
      onClose={onClose}
      onAnswer={(grant) => void answer(grant)}
    />
  );
}

/** The prompt itself, given what the sidecar said would run. */
export function SetupConsentView({
  pr,
  info,
  fromFork = false,
  error,
  busy,
  onClose,
  onAnswer,
}: {
  pr: Pick<ReviewWorkspacePr, "ref">;
  info: ReviewSetupInfo | null;
  /** The branch lives in a fork, so it is named with its owner. */
  fromFork?: boolean;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onAnswer: (grant: boolean) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Nothing is offered to run unless both what and where are known: the
  // answer pins both, and a null would pin nothing.
  const runnable = Boolean(info?.script && info.headSha);
  const branch = info?.branch ?? "unknown";
  const branchLabel = fromFork && info?.author ? `${info.author}:${branch}` : branch;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-consent-title"
        className="flex max-h-full w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-5 outline-none"
      >
        <div className="space-y-2">
          <h3 id="setup-consent-title" className="text-sm font-medium text-zinc-100">
            Run setup for {refDisplayRepo(pr.ref)}#{refNumber(pr.ref)}?
          </h3>
          <p className="text-xs text-zinc-300">
            Setup is not sandboxed. The script, and any code from this PR it runs (install hooks,
            build scripts, postinstall steps), runs as you, with your files, your credentials and
            your network. Only run it if you trust the author.
          </p>
          <p className="text-xs text-zinc-500">
            Until you agree, nothing from this PR runs: code navigation uses only the files, and
            mutation testing stays off.
          </p>
        </div>

        {!info && !error && <p className="text-sm text-zinc-500">Loading the setup script…</p>}

        {info && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-zinc-500">Author</dt>
              <dd className="text-zinc-200">{info.author ?? "unknown"}</dd>
              <dt className="text-zinc-500">Branch</dt>
              <dd className="truncate font-mono text-zinc-200" title={branchLabel}>
                {branchLabel}
                {fromFork && <span className="ml-2 font-sans text-amber-300">from a fork</span>}
              </dd>
              <dt className="text-zinc-500">Commit</dt>
              <dd className="truncate font-mono text-zinc-200" title={info.headSha ?? undefined}>
                {info.headSha ?? "unknown"}
              </dd>
            </dl>
            {info.script ? (
              <div className="min-h-0">
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                  Setup script, exactly as it will run
                </div>
                <pre className="max-h-64 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
                  {info.script}
                </pre>
              </div>
            ) : (
              <p className="text-sm text-zinc-400">This repo has no setup script to run.</p>
            )}
            {info.withheldEnv.length > 0 && (
              <p className="text-xs text-zinc-500">
                One narrow exception: the script doesn't get{" "}
                {info.withheldEnv.map((name, i) => (
                  <span key={name}>
                    {i > 0 && ", "}
                    <code className="font-mono text-zinc-300">{name}</code>
                  </span>
                ))}
                . Everything else it can reach, it can use.
              </p>
            )}
            {info.sandboxNotes && (
              <div className="space-y-1 text-xs text-zinc-400">
                {info.sandboxNotes
                  .split(/\n\s*\n/)
                  .filter((p) => p.trim())
                  .map((p) => (
                    <p key={p}>{p.trim()}</p>
                  ))}
              </div>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            Later
          </button>
          {info?.script && (
            <>
              <button
                type="button"
                onClick={() => onAnswer(false)}
                disabled={busy}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Don't run
              </button>
              <button
                type="button"
                onClick={() => onAnswer(true)}
                disabled={busy || !runnable}
                title={runnable ? undefined : "The PR's commit isn't known yet"}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
              >
                {busy ? "Starting…" : "Run setup"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
