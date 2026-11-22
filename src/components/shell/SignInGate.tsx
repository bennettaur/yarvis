import { useCallback, useEffect, useState } from "react";
import {
  type AuthStatus,
  type Enrollment,
  finishSetup,
  getAuthStatus,
  MIN_PASSPHRASE_CHARS,
  type SetUp,
  signIn,
  startSetup,
} from "../../lib/auth";
import { clearResourceCache } from "../../lib/resourceCache";
import { deviceToken, onAuthChange, saveDeviceToken, takeSignOutNotice } from "../../lib/server";
import { restartEvents } from "../../lib/serverEvents";
import CodePrompt from "./CodePrompt";
import { BackupCodes, cleanCode, TotpEnrollment } from "./TotpEnrollment";

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
const LINK = "self-start text-xs text-zinc-500 underline hover:text-zinc-300";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="text-xs text-zinc-400">
      <span className="mb-1 block uppercase tracking-wide">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className={INPUT}
      />
    </label>
  );
}

function Alert({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="break-words text-sm text-red-400" role="alert">
      {error}
    </p>
  );
}

/**
 * First run, in steps: the setup code and a passphrase, then the
 * authenticator app, then the backup codes. The device's token is kept only
 * after the backup codes are shown, since keeping it signs in and leaves this
 * screen.
 */
function SetupFlow({ onSignedIn }: { onSignedIn: () => void }) {
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [done, setDone] = useState<SetUp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="flex w-80 flex-col gap-3">
        <BackupCodes codes={done.backupCodes} />
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            saveDeviceToken(done.token);
            onSignedIn();
          }}
        >
          I've saved them — continue
        </button>
      </div>
    );
  }

  if (enrollment) {
    return (
      <div className="flex w-80 flex-col gap-3">
        <TotpEnrollment
          enrollment={enrollment}
          busy={busy}
          onConfirm={(totp) =>
            void run(async () => setDone(await finishSetup(enrollment.enrollmentId, totp)))
          }
        />
        <Alert error={error} />
      </div>
    );
  }

  const mismatch = again !== "" && again !== passphrase;
  const short = passphrase.length < MIN_PASSPHRASE_CHARS;
  return (
    <form
      className="flex w-80 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const name = deviceName.trim() || defaultDeviceName();
        void run(async () => setEnrollment(await startSetup(code.trim(), passphrase, name)));
      }}
    >
      <p className="text-sm text-zinc-400">
        This server isn't set up yet. Enter the setup code it printed when it started, and choose a
        passphrase of at least {MIN_PASSPHRASE_CHARS} characters.
      </p>
      <Field label="Setup code" value={code} onChange={setCode} autoComplete="one-time-code" />
      <Field
        label="Passphrase"
        type="password"
        value={passphrase}
        onChange={setPassphrase}
        autoComplete="new-password"
      />
      <Field
        label="Passphrase again"
        type="password"
        value={again}
        onChange={setAgain}
        autoComplete="new-password"
      />
      {mismatch && <p className="text-xs text-amber-400">The passphrases don't match.</p>}
      <Field label="Name for this device" value={deviceName} onChange={setDeviceName} />
      <Alert error={error} />
      <button
        type="submit"
        className={BUTTON}
        disabled={busy || !code.trim() || short || again !== passphrase}
      >
        {busy ? "Checking…" : "Next"}
      </button>
    </form>
  );
}

/** The passphrase, then a code from the app or, failing that, a backup code. */
function SignInForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const name = deviceName.trim() || defaultDeviceName();
      await signIn(
        passphrase,
        useBackup ? { backupCode: code.trim() } : { code: cleanCode(code) },
        name,
      );
      onSignedIn();
    } catch (e) {
      setError(errorText(e));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex w-80 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field
        label="Passphrase"
        type="password"
        value={passphrase}
        onChange={setPassphrase}
        autoComplete="current-password"
      />
      <Field
        label={useBackup ? "Backup code" : "Code from your authenticator app"}
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
      />
      <button
        type="button"
        className={LINK}
        onClick={() => {
          setUseBackup(!useBackup);
          setCode("");
        }}
      >
        {useBackup ? "Use a code from the app" : "Use a backup code"}
      </button>
      <Field label="Name for this device" value={deviceName} onChange={setDeviceName} />
      <Alert error={error} />
      <button type="submit" className={BUTTON} disabled={busy || !passphrase || !code.trim()}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

/** The sign-in screen, or on a server nobody has set up yet, first-run setup. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [notice] = useState(takeSignOutNotice);

  useEffect(() => {
    getAuthStatus()
      .then(setStatus)
      .catch((e) => setStatusError(errorText(e)));
  }, []);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-zinc-950 text-zinc-100">
      <div className="text-lg font-semibold tracking-tight">Yarvis</div>
      {notice && (
        <p className="w-80 text-sm text-amber-300" role="status">
          {notice}
        </p>
      )}
      {statusError && (
        <p className="w-80 text-sm text-red-400" role="alert">
          Couldn't reach the Yarvis server: {statusError}
        </p>
      )}
      {status?.setupRequired === true && <SetupFlow onSignedIn={onSignedIn} />}
      {status?.setupRequired === false && <SignInForm onSignedIn={onSignedIn} />}
    </div>
  );
}

/**
 * Shows sign-in until this client holds a device token, and again whenever the
 * server rejects it (a 401 signs the device out). Signed in, it also offers the
 * code prompt that actions needing a recent code use.
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
  return (
    <>
      {children}
      <CodePrompt />
    </>
  );
}
