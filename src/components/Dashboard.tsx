import { useCallback, useEffect, useState } from "react";
import {
  getDbHealth,
  getStatus,
  getHealth,
  type DbHealthResponse,
  type StatusResponse,
} from "../lib/api";
import {
  SECRETS,
  deleteSecret,
  listSecretStatus,
  restartSidecar,
  setSecret,
  type SecretKey,
  type SecretStatus,
} from "../lib/keychain";

type Health = "checking" | "ok" | "down";

export function StatusDot({ state }: { state: boolean | null }) {
  const color =
    state === null ? "bg-zinc-500" : state ? "bg-emerald-500" : "bg-red-500";
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

export default function Dashboard() {
  const [health, setHealth] = useState<Health>("checking");
  const [status, setStatusState] = useState<StatusResponse | null>(null);
  const [db, setDb] = useState<DbHealthResponse | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

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
    try {
      setSecrets(await listSecretStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const onSave = useCallback(
    async (key: SecretKey) => {
      const value = inputs[key]?.trim();
      if (!value) return;
      await setSecret(key, value);
      setInputs((prev) => ({ ...prev, [key]: "" }));
      // Reload the sidecar so it picks up the new secret immediately.
      await restartSidecar();
      await refresh();
    },
    [inputs, refresh],
  );

  const onClear = useCallback(
    async (key: SecretKey) => {
      await deleteSecret(key);
      await restartSidecar();
      await refresh();
    },
    [refresh],
  );

  const isPresent = (key: SecretKey) =>
    secrets.find((s) => s.key === key)?.present ?? false;

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
          System
        </h2>
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
        <Row
          label="Gemini key"
          value={<StatusDot state={status?.providers.gemini ?? null} />}
        />
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Secrets
        </h2>
        <p className="mb-4 text-xs text-zinc-500">
          Stored in the macOS Keychain. Saving reloads the sidecar so changes
          take effect right away.
        </p>
        <div className="space-y-5">
          {SECRETS.map((meta) => (
            <div key={meta.key}>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-sm font-medium">{meta.label}</label>
                <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <StatusDot state={isPresent(meta.key)} />
                  {isPresent(meta.key) ? "set" : "not set"}
                </span>
              </div>
              <p className="mb-2 text-xs text-zinc-500">{meta.help}</p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={inputs[meta.key] ?? ""}
                  placeholder={meta.placeholder}
                  onChange={(e) =>
                    setInputs((prev) => ({ ...prev, [meta.key]: e.target.value }))
                  }
                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
                />
                <button
                  onClick={() => void onSave(meta.key)}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500"
                >
                  Save
                </button>
                <button
                  onClick={() => void onClear(meta.key)}
                  disabled={!isPresent(meta.key)}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  Clear
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {error && (
        <p className="text-sm text-red-400">
          {error} — invoke commands require the app to run under Tauri.
        </p>
      )}
    </div>
  );
}
