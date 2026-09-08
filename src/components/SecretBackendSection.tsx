import { useCallback, useEffect, useState } from "react";
import { restartAndWait } from "../lib/restart";
import {
  type Copied,
  getSettings,
  type SecretBackend,
  type Settings,
  setSecretBackend,
} from "../lib/settings";

const CHOICES: { value: SecretBackend; label: string }[] = [
  { value: "keychain", label: "macOS Keychain" },
  { value: "onepassword", label: "1Password" },
];

function storeName(backend: SecretBackend): string {
  return backend === "onepassword" ? "1Password" : "macOS Keychain";
}

/** What to tell the user became of their secrets. The third case is the one
 *  that matters: the app is now running on a different set of credentials than
 *  it was a moment ago, which nothing else on screen would reveal. */
function copyNotice(copied: Copied, backend: SecretBackend): string {
  switch (copied) {
    case "secrets":
      return `Secrets copied into ${storeName(backend)}. The previous store still holds its own copy.`;
    case "nothingToCopy":
      return `Now using ${storeName(backend)}. There were no stored secrets to copy.`;
    case "targetAlreadyHadSecrets":
      return `${storeName(backend)} already held secrets, so nothing was copied and they were left untouched. The app is now using those, not the ones it had before.`;
  }
}

/**
 * Chooses where the secrets in `KeychainSection` and its siblings are stored:
 * the macOS Keychain, or a 1Password item reached through the `op` CLI. Saving
 * copies the current secrets into the new store and reloads the sidecar, so
 * what the app is running with is what the newly selected store holds.
 */
export default function SecretBackendSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedBackend, setSelectedBackend] = useState<SecretBackend>("keychain");
  const [vault, setVault] = useState("");
  const [item, setItem] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applySettings = useCallback((next: Settings) => {
    setSettings(next);
    setSelectedBackend(next.secretBackend ?? "keychain");
    setVault(next.onePasswordVault ?? "");
    setItem(next.onePasswordItem ?? "");
  }, []);

  useEffect(() => {
    getSettings()
      .then(applySettings)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [applySettings]);

  const onSave = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await setSecretBackend(
        selectedBackend,
        vault.trim() || null,
        item.trim() || null,
      );
      applySettings(result.settings);
      setNotice(copyNotice(result.copied, selectedBackend));
      await restartAndWait();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [applySettings, selectedBackend, vault, item]);

  const savedBackend: SecretBackend = settings?.secretBackend ?? "keychain";

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Secret store
      </h2>
      <p className="mb-4 text-xs text-zinc-500">
        Where the secrets below are kept. Switching copies them into the new store and leaves the
        old copy in place — unless the new store already holds secrets, which are never overwritten.
      </p>

      <div className="mb-4 flex gap-4">
        {CHOICES.map((choice) => (
          <label key={choice.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="secret-backend"
              value={choice.value}
              checked={selectedBackend === choice.value}
              onChange={() => setSelectedBackend(choice.value)}
            />
            {choice.label}
          </label>
        ))}
      </div>

      {selectedBackend === "onepassword" && (
        <div className="mb-4 space-y-4">
          <p className="text-xs text-zinc-500">
            Needs the 1Password CLI (<code>op</code>) with desktop app integration turned on — that
            integration is what puts each access behind Touch ID. The item is created on first save
            as a Secure Note; the secrets live in its notes field.
          </p>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="op-vault">
              Vault
            </label>
            <input
              id="op-vault"
              type="text"
              value={vault}
              placeholder="Private"
              onChange={(e) => setVault(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="op-item">
              Item title
            </label>
            <input
              id="op-item"
              type="text"
              value={item}
              placeholder="Yarvis Secrets"
              onChange={(e) => setItem(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void onSave()}
          disabled={busy || settings === null}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
        >
          {busy ? "Switching…" : "Save"}
        </button>
        <span className="text-xs text-zinc-500">In use: {storeName(savedBackend)}</span>
      </div>

      {notice && <p className="mt-3 text-sm text-zinc-400">{notice}</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
