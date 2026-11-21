import { useCallback, useEffect, useState } from "react";
import { type AuthStatus, getAuthStatus, setUpWithCode, signInWithPasskey } from "../../lib/auth";
import { clearResourceCache } from "../../lib/resourceCache";
import { deviceToken, onAuthChange } from "../../lib/server";
import { restartEvents } from "../../lib/serverEvents";

type Gate = "checking" | "signed-in" | "signed-out";

/** A starting name for the device list, which the user can change before signing in. */
function defaultDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = ["Firefox", "Edg", "Chrome", "Safari"].find((name) => ua.includes(`${name}/`));
  const label = browser === "Edg" ? "Edge" : (browser ?? "Browser");
  return ua.includes("Mac") ? `${label} on Mac` : label;
}

const BUTTON =
  "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50";
const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100";

/**
 * The sign-in screen: a passkey sign-in, or on a server nobody has set up yet,
 * registering the first passkey with the setup code the server printed.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAuthStatus()
      .then(setStatus)
      .catch((e) => setStatusError(e instanceof Error ? e.message : String(e)));
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setup = status?.setupRequired ?? false;

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-zinc-950 text-zinc-100">
      <div className="text-lg font-semibold tracking-tight">Yarvis</div>
      <form
        className="flex w-80 flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const name = deviceName.trim() || defaultDeviceName();
          void run(() => (setup ? setUpWithCode(code.trim(), name) : signInWithPasskey(name)));
        }}
      >
        {statusError && (
          <p className="text-sm text-red-400" role="alert">
            Couldn't reach the Yarvis server: {statusError}
          </p>
        )}
        {setup ? (
          <>
            <p className="text-sm text-zinc-400">
              This server has no passkey yet. Enter the setup code it printed when it started, then
              create a passkey for it.
            </p>
            <label className="text-xs text-zinc-400">
              <span className="mb-1 block uppercase tracking-wide">Setup code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                className={INPUT}
              />
            </label>
          </>
        ) : (
          <p className="text-sm text-zinc-400">Sign in with your passkey.</p>
        )}
        <label className="text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Name for this device</span>
          <input
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            className={INPUT}
          />
        </label>
        {error && (
          <p className="break-words text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className={BUTTON}
          disabled={busy || !status || (setup && !code.trim())}
        >
          {busy ? "Waiting for the passkey…" : setup ? "Create passkey" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/**
 * Shows sign-in until this client holds a device token, and again whenever the
 * server rejects it (a 401 signs the device out).
 */
export default function SignInGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<Gate>("checking");

  useEffect(() => {
    let active = true;
    deviceToken().then((token) => {
      if (active) setGate(token ? "signed-in" : "signed-out");
    });
    const off = onAuthChange((signedIn) => {
      // What the last device loaded isn't for whoever signs in next.
      if (!signedIn) clearResourceCache();
      setGate(signedIn ? "signed-in" : "signed-out");
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const signedIn = useCallback(() => {
    setGate("signed-in");
    restartEvents();
  }, []);

  if (gate === "checking") return null;
  if (gate === "signed-out") return <SignIn onSignedIn={signedIn} />;
  return <>{children}</>;
}
