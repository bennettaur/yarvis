import { useCallback, useEffect, useState } from "react";
import { getHealth, waitForSidecarReady } from "../lib/api";
import {
  deleteSecret,
  listSecretStatus,
  restartSidecar,
  SECRETS,
  type SecretKey,
  type SecretStatus,
  setSecret,
} from "../lib/keychain";
import { StatusDot } from "./Dashboard";
import { MaskedInput } from "./MaskedInput";

/** Trigger a sidecar restart and wait for it to come back ready. */
async function restartAndWait(): Promise<void> {
  let priorUptimeMs: number | undefined;
  try {
    priorUptimeMs = (await getHealth()).uptimeMs;
  } catch {
    // already down — the readiness poll will catch the new process anyway.
  }
  await restartSidecar();
  await waitForSidecarReady({ minUptimeMsBefore: priorUptimeMs });
}

/**
 * Manages the built-in app secrets (database URL, provider API keys, GitHub
 * token, Google OAuth credentials). Values live in the macOS Keychain; saving
 * reloads the sidecar so changes take effect immediately.
 */
export default function KeychainSection() {
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSecrets(await listSecretStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = useCallback(
    async (key: SecretKey) => {
      const value = inputs[key]?.trim();
      if (!value) return;
      await setSecret(key, value);
      setInputs((prev) => ({ ...prev, [key]: "" }));
      await restartAndWait();
      await refresh();
    },
    [inputs, refresh],
  );

  const onClear = useCallback(
    async (key: SecretKey) => {
      await deleteSecret(key);
      await restartAndWait();
      await refresh();
    },
    [refresh],
  );

  const isPresent = (key: SecretKey) => secrets.find((s) => s.key === key)?.present ?? false;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Secrets</h2>
      <p className="mb-4 text-xs text-zinc-500">
        Stored in the macOS Keychain. Saving reloads the sidecar so changes take effect right away.
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
              <MaskedInput
                value={inputs[meta.key] ?? ""}
                placeholder={meta.placeholder}
                onChange={(v) => setInputs((prev) => ({ ...prev, [meta.key]: v }))}
              />
              <button
                onClick={() => void onSave(meta.key)}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
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
      {error && (
        <p className="mt-3 text-sm text-red-400">
          {error} — invoke commands require the app to run under Tauri.
        </p>
      )}
    </section>
  );
}
