import { useCallback, useEffect, useState } from "react";
import { getHealth } from "../../lib/api";
import { restartSidecar } from "../../lib/keychain";

type Phase = "connecting" | "migrating" | "ready" | "error";

const STATUS_MESSAGE: Record<"connecting" | "migrating", string> = {
  connecting: "Connecting to the local service…",
  migrating: "Preparing your database…",
};

// How long to wait before offering an escape hatch, so a stuck or very slow
// boot never traps the user (e.g. a bad database URL they need to fix in
// Settings).
const SLOW_AFTER_MS = 6000;

function BootSpinner() {
  return (
    <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-indigo-400" />
  );
}

/**
 * Gates the app behind a loading screen until the sidecar reports ready
 * (`/health` `ready: true`). The sidecar applies database migrations on
 * startup; this surfaces that as "Preparing your database…" and lets the user
 * retry or continue if it stalls or fails.
 */
export default function BootGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [detail, setDetail] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const h = await getHealth();
        if (cancelled) return;
        if (h.ready === false) {
          if (h.phase === "error") {
            setDetail(h.error ?? "Database migration failed.");
            setPhase("error");
            return; // Stop polling; wait for the user to retry or continue.
          }
          setPhase("migrating");
        } else {
          setPhase("ready");
          return;
        }
      } catch {
        // Sidecar not reachable yet (still spawning); keep waiting.
        if (cancelled) return;
        setPhase("connecting");
      }
      timer = setTimeout(poll, 500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt]);

  useEffect(() => {
    if (phase === "ready" || phase === "error") return;
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [phase, attempt]);

  const retry = useCallback(async () => {
    setDetail(null);
    setSlow(false);
    setPhase("connecting");
    try {
      await restartSidecar();
    } catch {
      // If the restart command itself fails, polling will surface the state.
    }
    setAttempt((a) => a + 1);
  }, []);

  const proceed = useCallback(() => setPhase("ready"), []);

  if (phase === "ready") return <>{children}</>;

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-zinc-950 text-zinc-100">
      <div className="text-lg font-semibold tracking-tight">Yarvis</div>
      {phase === "error" ? (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-sm text-red-400">Couldn't start the local service.</p>
          {detail && <p className="break-words text-xs text-zinc-500">{detail}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => void retry()}
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500"
            >
              Retry
            </button>
            <button
              onClick={proceed}
              className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Continue anyway
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center">
          <BootSpinner />
          <p className="text-sm text-zinc-400">{STATUS_MESSAGE[phase]}</p>
          {slow && (
            <button
              onClick={proceed}
              className="text-xs text-zinc-500 underline hover:text-zinc-300"
            >
              Continue anyway
            </button>
          )}
        </div>
      )}
    </div>
  );
}
