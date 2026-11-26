import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AuthStatus,
  getAuthStatus,
  unlockVault,
  unlockVaultWithRecovery,
} from "../../lib/auth";
import { clearResourceCache } from "../../lib/resourceCache";
import { onServerEvent } from "../../lib/serverEvents";

const BUTTON =
  "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50";
const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm font-mono text-zinc-100";

/** `unknown`: the status check failed, so a later lock may still be real. */
type Vault = AuthStatus["vault"] | "checking" | "unknown";

/**
 * Holds the app while the server's vault is locked. The sidecar can't start
 * until the vault opens, so without this the app would wait on it forever.
 * Servers that keep secrets elsewhere report `absent` and pass straight through.
 */
export default function VaultGate({ children }: { children: React.ReactNode }) {
  const [vault, setVault] = useState<Vault>("checking");
  // The event handler below is registered once, so it reads the state here.
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

  const check = useCallback(() => {
    getAuthStatus()
      .then((status) => setVault(status.vault))
      // An unreachable server is the sign-in and boot screens' problem.
      .catch(() => setVault("unknown"));
  }, []);

  useEffect(() => {
    check();
    return onServerEvent("vault.locked", () => {
      // "absent" means the secrets live outside the vault, so a lock here is a
      // vault holding only the signing key. The sidecar keeps running and the
      // app stays open; the Approvals section offers the unlock.
      if (vaultRef.current === "absent") return;
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
        <VaultUnlockForm
          className="w-80"
          prompt="The server's vault is locked. Unlock it with the vault's own passphrase, not your sign-in one, to start the assistant."
          onUnlocked={onUnlocked}
        />
      )}
    </div>
  );
}

/** The vault passphrase (or recovery key) form, for any screen that unlocks the vault. */
export function VaultUnlockForm({
  prompt,
  onUnlocked,
  className = "",
}: {
  prompt: string;
  onUnlocked: () => void;
  className?: string;
}) {
  const [secret, setSecret] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async () => {
    setError(null);
    setBusy(true);
    try {
      await (useRecovery ? unlockVaultWithRecovery(secret.trim()) : unlockVault(secret));
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSecret("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={`flex flex-col gap-3 ${className}`}
      onSubmit={(e) => {
        e.preventDefault();
        void unlock();
      }}
    >
      <p className="text-sm text-zinc-400">{prompt}</p>
      <label className="text-xs text-zinc-400">
        <span className="mb-1 block uppercase tracking-wide">
          {useRecovery ? "Recovery key" : "Vault passphrase"}
        </span>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={INPUT}
        />
      </label>
      <button type="submit" className={BUTTON} disabled={busy || !secret.trim()}>
        {busy ? "Unlocking…" : "Unlock"}
      </button>
      <button
        type="button"
        className="self-start text-xs text-zinc-500 underline hover:text-zinc-300"
        onClick={() => {
          setUseRecovery(!useRecovery);
          setSecret("");
        }}
      >
        {useRecovery ? "Use the vault passphrase" : "Use the recovery key"}
      </button>
      {error && (
        <p className="break-words text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
