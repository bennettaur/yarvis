import { useCallback, useEffect, useState } from "react";
import {
  type DbHealthResponse,
  getDbHealth,
  getHealth,
  getStatus,
  type StatusResponse,
} from "../lib/api";

type Health = "checking" | "ok" | "down";

export function StatusDot({ state }: { state: boolean | null }) {
  const color = state === null ? "bg-zinc-500" : state ? "bg-emerald-500" : "bg-red-500";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-zinc-400">{label}</span>
      <span className="flex items-center gap-2 text-zinc-100">{value}</span>
    </div>
  );
}

/**
 * Read-only system status. Configuration (secrets, custom providers) lives in
 * the Settings tab.
 */
export default function Dashboard() {
  const [health, setHealth] = useState<Health>("checking");
  const [status, setStatusState] = useState<StatusResponse | null>(null);
  const [db, setDb] = useState<DbHealthResponse | null>(null);

  const refresh = useCallback(async () => {
    try {
      await getHealth();
      setHealth("ok");
    } catch {
      setHealth("down");
    }
    try {
      setStatusState(await getStatus());
      setDb(await getDbHealth());
    } catch {
      setStatusState(null);
      setDb(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">System</h2>
        <Row
          label="Sidecar"
          value={
            <>
              <StatusDot state={health === "checking" ? null : health === "ok"} />
              {health}
            </>
          }
        />
        <Row
          label="Database"
          value={
            db === null ? (
              <span className="text-zinc-500">unknown</span>
            ) : !db.configured ? (
              <span className="text-zinc-500">not configured</span>
            ) : (
              <>
                <StatusDot state={db.reachable} />
                {db.reachable ? "reachable" : "unreachable"}
              </>
            )
          }
        />
        <Row
          label="Anthropic key"
          value={<StatusDot state={status?.providers.anthropic ?? null} />}
        />
        <Row label="Gemini key" value={<StatusDot state={status?.providers.gemini ?? null} />} />
      </section>
    </div>
  );
}
