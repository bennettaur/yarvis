import { useEffect, useState } from "react";
import { SidecarError } from "../lib/api";
import { type Approval, answerApproval, listApprovals } from "../lib/auth";
import { invalidate, SIDECAR_FRESHNESS, useCachedResource } from "../lib/resourceCache";
import { onServerEvent } from "../lib/serverEvents";

const APPROVALS_KEY = "server:approvals";

const BUTTON = "rounded-md border px-2.5 py-1 text-xs disabled:opacity-50";

/**
 * What the server is waiting on the user to allow, such as signing a commit.
 * Any device with the approve scope can answer, and the first answer wins.
 * `hideWhenEmpty` lets the app shell show it only while something waits.
 */
export default function ApprovalsList({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const approvals = useCachedResource(APPROVALS_KEY, listApprovals, SIDECAR_FRESHNESS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reload = () => invalidate(APPROVALS_KEY);
    const offRequested = onServerEvent("approval.requested", reload);
    const offAnswered = onServerEvent("approval.answered", reload);
    return () => {
      offRequested();
      offAnswered();
    };
  }, []);

  const pending = (approvals.data ?? []).filter((a) => !a.status || a.status === "pending");

  const answer = async (approval: Approval, approve: boolean) => {
    setError(null);
    setBusyId(approval.id);
    try {
      await answerApproval(approval.id, approve);
    } catch (e) {
      // A 409 means another device answered first; the reload below shows it.
      if (!(e instanceof SidecarError && e.status === 409)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusyId(null);
      invalidate(APPROVALS_KEY);
    }
  };

  if (hideWhenEmpty && pending.length === 0) return null;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Approvals</h2>
      {!hideWhenEmpty && (
        <p className="mb-4 text-xs text-zinc-500">
          Actions the server waits on you to allow. The first device to answer decides.
        </p>
      )}
      {(error ?? approvals.error) && (
        <p className="mb-3 text-sm text-red-400" role="alert">
          {error ?? approvals.error}
        </p>
      )}
      {pending.length === 0 && !approvals.loading && (
        <p className="text-xs text-zinc-500">Nothing is waiting.</p>
      )}
      <ul className="space-y-2">
        {pending.map((approval) => (
          <li
            key={approval.id}
            className="flex items-center gap-3 rounded-md border border-zinc-800 px-3 py-2"
          >
            <span className="min-w-0 flex-1 text-sm">
              <span className="block text-zinc-200">{approval.summary ?? approval.kind}</span>
              {approval.detail && (
                <span className="block break-all text-xs text-zinc-500">{approval.detail}</span>
              )}
            </span>
            <button
              type="button"
              className={`${BUTTON} border-emerald-700 text-emerald-300 hover:bg-emerald-950`}
              disabled={busyId === approval.id}
              onClick={() => void answer(approval, true)}
            >
              Approve
            </button>
            <button
              type="button"
              className={`${BUTTON} border-zinc-700 text-zinc-300 hover:bg-zinc-800`}
              disabled={busyId === approval.id}
              onClick={() => void answer(approval, false)}
            >
              Deny
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
