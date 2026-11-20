import { useCallback, useState } from "react";
import {
  ALL_SCOPES,
  type Device,
  getMyDevice,
  listDevices,
  mintDeviceToken,
  revokeDevice,
  type Scope,
  type SignedIn,
} from "../lib/auth";
import { writeClipboard } from "../lib/clipboard";
import { invalidate, SIDECAR_FRESHNESS, useCachedResource } from "../lib/resourceCache";
import { signOut } from "../lib/server";

const DEVICES_KEY = "server:devices";
const ME_KEY = "server:devices:me";

const BUTTON =
  "rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50";

function when(value: Device["lastSeenAt"]): string {
  if (value === null || value === undefined) return "never";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The clients signed in to this server, and tokens minted for the ones that
 * can't use a passkey (a Tauri app pointed at a remote server, a script).
 * Revoking a device ends its sessions on its next request.
 */
export default function DevicesSection() {
  const me = useCachedResource(ME_KEY, getMyDevice, SIDECAR_FRESHNESS);
  const isAdmin = me.data?.scopes.includes("admin") ?? false;
  const devices = useCachedResource(isAdmin ? DEVICES_KEY : null, listDevices, SIDECAR_FRESHNESS);

  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read", "chat"]);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<SignedIn | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    invalidate(DEVICES_KEY);
  }, []);

  const revoke = useCallback(
    async (device: Device) => {
      setError(null);
      setBusyId(device.id);
      try {
        await revokeDevice(device.id);
        if (device.id === me.data?.id) {
          signOut();
          return;
        }
        reload();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusyId(null);
      }
    },
    [me.data?.id, reload],
  );

  const mint = useCallback(async () => {
    setError(null);
    setMinted(null);
    setCopied(false);
    if (!name.trim()) {
      setError("Give the token a name, so you can tell it apart later.");
      return;
    }
    if (scopes.length === 0) {
      setError("Pick at least one scope.");
      return;
    }
    setMinting(true);
    try {
      setMinted(await mintDeviceToken(name.trim(), scopes));
      setName("");
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setMinting(false);
    }
  }, [name, scopes, reload]);

  const toggleScope = (scope: Scope) =>
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );

  const copy = async () => {
    if (!minted) return;
    try {
      await writeClipboard(minted.token);
      setCopied(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const list = (devices.data ?? []).filter((d) => !d.revokedAt);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Devices</h2>
      <p className="mb-4 text-xs text-zinc-500">
        Every browser, app or script signed in to this Yarvis server. Each one has its own token and
        scopes, and revoking one signs it out at once.
      </p>

      {(error || me.error || devices.error) && (
        <p className="mb-3 text-sm text-red-400" role="alert">
          {error ?? me.error ?? devices.error}
        </p>
      )}

      {me.data && (
        <p className="mb-3 text-sm text-zinc-300">
          This device: <span className="font-medium">{me.data.name}</span>{" "}
          <span className="text-xs text-zinc-500">({me.data.scopes.join(", ")})</span>
        </p>
      )}

      {!isAdmin && me.data && (
        <p className="text-xs text-zinc-500">Managing devices needs the admin scope.</p>
      )}

      {isAdmin && (
        <>
          <ul className="mb-5 divide-y divide-zinc-800 rounded-md border border-zinc-800">
            {list.map((device) => (
              <li key={device.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-zinc-200">
                    {device.name}
                    {device.id === me.data?.id && (
                      <span className="ml-2 text-xs text-sky-400">this device</span>
                    )}
                  </span>
                  <span className="block text-xs text-zinc-500">
                    {device.kind === "token" ? "Token" : "Passkey"} · {device.scopes.join(", ")} ·
                    last seen {when(device.lastSeenAt)}
                  </span>
                </span>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busyId === device.id}
                  onClick={() => void revoke(device)}
                >
                  {busyId === device.id ? "Revoking…" : "Revoke"}
                </button>
              </li>
            ))}
            {list.length === 0 && !devices.loading && (
              <li className="px-3 py-2 text-xs text-zinc-500">No devices.</li>
            )}
          </ul>

          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Pair a device with a token
          </h3>
          <p className="mb-3 text-xs text-zinc-500">
            For a client that can't use a passkey. Paste the token into it. Give it only the scopes
            it needs: admin can manage devices and secrets.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-zinc-400">
              <span className="mb-1 block uppercase tracking-wide">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Work laptop"
                className="w-48 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
              />
            </label>
            <fieldset className="flex gap-3 text-xs text-zinc-300">
              <legend className="sr-only">Scopes</legend>
              {ALL_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  {scope}
                </label>
              ))}
            </fieldset>
            <button type="button" className={BUTTON} disabled={minting} onClick={() => void mint()}>
              {minting ? "Creating…" : "Create token"}
            </button>
          </div>

          {minted && (
            <div className="mt-4 rounded-md border border-amber-700/60 bg-amber-950/30 p-3">
              <p className="mb-2 text-xs text-amber-300">
                Copy this token now. It won't be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-zinc-950 px-2 py-1 text-xs text-zinc-100">
                  {minted.token}
                </code>
                <button type="button" className={BUTTON} onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy"}
                </button>
                <button type="button" className={BUTTON} onClick={() => setMinted(null)}>
                  Done
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
