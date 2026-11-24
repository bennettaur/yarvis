import { useEffect, useState } from "react";
import { SidecarError } from "../lib/api";
import {
  type Approval,
  answerApproval,
  endSigningGrant,
  getSshAgentStatus,
  listApprovals,
} from "../lib/auth";
import { invalidate, SIDECAR_FRESHNESS, useCachedResource } from "../lib/resourceCache";
import { onServerEvent } from "../lib/serverEvents";

const APPROVALS_KEY = "server:approvals";
const SIGNING_KEY = "server:ssh-agent";

const BUTTON = "rounded-md border px-2.5 py-1 text-xs disabled:opacity-50";

/** How long an approval may cover later requests, when it offers that. */
const GRANT_DURATIONS = [
  { secs: 5 * 60, label: "5 min" },
  { secs: 15 * 60, label: "15 min" },
  { secs: 60 * 60, label: "1 hour" },
];

/** The events that can start or end a signing grant. */
const SIGNING_EVENTS = [
  "approval.answered",
  "ssh_agent.grant_started",
  "ssh_agent.grant_ended",
  "vault.locked",
];

const formatClockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * What the server is waiting on the user to allow, such as signing a commit.
 * Any device with the approve scope can answer, and the first answer wins.
 * A signature can also be approved for a while, which this shows until it
 * ends. `hideWhenEmpty` lets the app shell show it only while something
 * waits or signing is allowed.
 */
export default function ApprovalsList({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const approvals = useCachedResource(APPROVALS_KEY, listApprovals, SIDECAR_FRESHNESS);
  const signing = useCachedResource(SIGNING_KEY, getSshAgentStatus, SIDECAR_FRESHNESS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reload = () => invalidate(APPROVALS_KEY);
    const reloadSigning = () => invalidate(SIGNING_KEY);
    const offs = [
      onServerEvent("approval.requested", reload),
      onServerEvent("approval.answered", reload),
      ...SIGNING_EVENTS.map((kind) => onServerEvent(kind, reloadSigning)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  const grantEnds = signing.data?.grantEndsAt;
  const [now, setNow] = useState(() => Date.now());
  // Re-render when the grant runs out, so it doesn't stay on screen after.
  useEffect(() => {
    if (grantEnds === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, grantEnds - Date.now()));
    return () => clearTimeout(timer);
  }, [grantEnds]);
  const grantActive = grantEnds !== undefined && grantEnds > now;

  const pending = approvals.data ?? [];

  const answer = async (approval: Approval, approve: boolean, allowForSecs?: number) => {
    setError(null);
    setBusyId(approval.id);
    try {
      await answerApproval(approval.id, approve, allowForSecs);
    } catch (e) {
      // A 409 means another device answered first; the reload below shows it.
      if (!(e instanceof SidecarError && e.status === 409)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusyId(null);
      invalidate(APPROVALS_KEY);
      if (allowForSecs !== undefined) invalidate(SIGNING_KEY);
    }
  };

  const stopGrant = async () => {
    setError(null);
    setStopping(true);
    try {
      await endSigningGrant();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
      // Even after a failure: the grant may have ended some other way.
      invalidate(SIGNING_KEY);
    }
  };

  if (hideWhenEmpty && pending.length === 0 && !grantActive) return null;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Approvals</h2>
      {!hideWhenEmpty && (
        <p className="mb-4 text-xs text-zinc-500">
          Actions the server waits on you to allow. The first device to answer decides.
        </p>
      )}
      {(error ?? approvals.error ?? signing.error) && (
        <p className="mb-3 text-sm text-red-400" role="alert">
          {error ?? approvals.error ?? signing.error}
        </p>
      )}
      {grantActive && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-amber-800 bg-amber-950/40 px-3 py-2">
          <span className="min-w-0 flex-1 text-sm text-amber-200">
            Signing commits without asking until {formatClockTime(grantEnds)}
          </span>
          <button
            type="button"
            className={`${BUTTON} border-amber-700 text-amber-200 hover:bg-amber-900`}
            disabled={stopping}
            onClick={() => void stopGrant()}
          >
            Stop
          </button>
        </div>
      )}
      {pending.length === 0 && !approvals.loading && !grantActive && (
        <p className="text-xs text-zinc-500">Nothing is waiting.</p>
      )}
      <ul className="space-y-2">
        {pending.map((approval) => {
          const busy = busyId === approval.id;
          const maxAllowForSecs = approval.maxAllowForSecs ?? 0;
          const offeredDurations = GRANT_DURATIONS.filter((d) => d.secs <= maxAllowForSecs);
          return (
            <li key={approval.id} className="rounded-md border border-zinc-800 px-3 py-2">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block break-all text-zinc-200">{approval.summary}</span>
                  <span className="block text-xs text-zinc-500">{approval.kind}</span>
                </span>
                <button
                  type="button"
                  className={`${BUTTON} border-emerald-700 text-emerald-300 hover:bg-emerald-950`}
                  disabled={busy}
                  onClick={() => void answer(approval, true)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className={`${BUTTON} border-zinc-700 text-zinc-300 hover:bg-zinc-800`}
                  disabled={busy}
                  onClick={() => void answer(approval, false)}
                >
                  Deny
                </button>
              </div>
              {offeredDurations.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span>Approve and stop asking for</span>
                  {offeredDurations.map((d) => (
                    <button
                      key={d.secs}
                      type="button"
                      className={`${BUTTON} border-zinc-700 text-zinc-300 hover:bg-zinc-800`}
                      disabled={busy}
                      onClick={() => void answer(approval, true, d.secs)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
