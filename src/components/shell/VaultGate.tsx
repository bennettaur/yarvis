import { useCallback, useEffect, useState } from "react";
import {
  type AuthStatus,
  getAuthStatus,
  unlockVaultWithPasskey,
  unlockVaultWithRecovery,
} from "../../lib/auth";
import { clearResourceCache } from "../../lib/resourceCache";
import { onServerEvent } from "../../lib/serverEvents";

const BUTTON =
  "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50";
const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm font-mono text-zinc-100";

type Vault = AuthStatus["vault"] | "checking";

/**
 * Holds the app while the server's vault is locked. The sidecar can't start
 * until the vault opens, so without this the app would wait on it forever.
 * Servers that keep secrets elsewhere report `absent` and pass straight through.
 */
export default function VaultGate({ children }: { children: React.ReactNode }) {
  const [vault, setVault] = useState<Vault>("checking");

  const check = useCallback(() => {
    getAuthStatus()
      .then((status) => setVault(status.vault))
      // An unreachable server is the sign-in and boot screens' problem.
      .catch(() => setVault("absent"));
  }, []);

  useEffect(() => {
    check();
    return onServerEvent("vault.locked", () => {
      // Whatever was loaded came from a sidecar that has stopped.
      clearResourceCache();
      setVault("locked");
    });
  }, [check]);

  if (vault === "checking") return null;
  if (vault === "locked" || vault === "uninitialized") {
    return <VaultUnlock vault={vault} onUnlocked={() => setVault("unlocked")} />;
  }
  return <>{children}</>;
}

export function VaultUnlock({
  vault,
  onUnlocked,
}: {
  vault: "locked" | "uninitialized";
  onUnlocked: () => void;
}) {
  const [recoveryKey, setRecoveryKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRecoveryKey("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-zinc-950 text-zinc-100">
      <div className="text-lg font-semibold tracking-tight">Yarvis</div>
      {vault === "uninitialized" ? (
        <p className="w-80 text-sm text-zinc-400">
          This server keeps its secrets in a vault that hasn't been created yet. Run{" "}
          <code className="text-zinc-200">yarvis-server vault init</code> on the server, then
          reload.
        </p>
      ) : (
        <div className="flex w-80 flex-col gap-3">
          <p className="text-sm text-zinc-400">
            The server's vault is locked. Unlock it to start the assistant.
          </p>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void run(unlockVaultWithPasskey)}
          >
            {busy ? "Unlocking…" : "Unlock with passkey"}
          </button>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => unlockVaultWithRecovery(recoveryKey.trim()));
            }}
          >
            <label className="text-xs text-zinc-400">
              <span className="mb-1 block uppercase tracking-wide">Recovery key</span>
              <input
                type="password"
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className={INPUT}
              />
            </label>
            <button
              type="submit"
              className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              disabled={busy || !recoveryKey.trim()}
            >
              Unlock with recovery key
            </button>
          </form>
          {error && (
            <p className="break-words text-sm text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
