import { useState } from "react";
import {
  changePassphrase,
  type Enrollment,
  finishTotpReenroll,
  getAccount,
  MIN_PASSPHRASE_CHARS,
  regenerateBackupCodes,
  signOutOtherDevices,
  startTotpReenroll,
} from "../lib/auth";
import { invalidate, SIDECAR_FRESHNESS, useCachedResource } from "../lib/resourceCache";
import { BackupCodes, TotpEnrollment } from "./shell/TotpEnrollment";

const ACCOUNT_KEY = "server:account";

const BUTTON =
  "rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50";
const INPUT = "w-64 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The account every sign-in uses: its passphrase, the authenticator app, the
 * backup codes, and signing out everything but this device. Each change asks
 * for a recent code from the app first.
 */
export default function AccountSection() {
  const account = useCachedResource(ACCOUNT_KEY, getAccount, SIDECAR_FRESHNESS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const run = async (action: () => Promise<string | void>) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const message = await action();
      if (message) setNotice(message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const signedOut = (count: number) =>
    count > 0 ? ` ${count} other device${count === 1 ? "" : "s"} signed out.` : "";

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Account</h2>
      <p className="mb-4 text-xs text-zinc-500">
        Signing in takes the passphrase and a code from your authenticator app, or a backup code.
        {account.data && ` ${account.data.backupCodesLeft} backup codes left.`}
      </p>
      {error && (
        <p className="mb-3 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="mb-3 text-sm text-emerald-400">{notice}</p>}

      <label className="mb-4 flex items-center gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={signOutOthers}
          onChange={(e) => setSignOutOthers(e.target.checked)}
        />
        Also sign out every other device when changing the passphrase or authenticator
      </label>

      <form
        className="mb-5 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const result = await changePassphrase(current, next, signOutOthers);
            setCurrent("");
            setNext("");
            return `Passphrase changed.${signedOut(result.revokedDevices.length)}`;
          });
        }}
      >
        <label className="text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Current passphrase</span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className={INPUT}
          />
        </label>
        <label className="text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">New passphrase</span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            className={INPUT}
          />
        </label>
        <button
          type="submit"
          className={BUTTON}
          disabled={busy || !current || next.length < MIN_PASSPHRASE_CHARS}
        >
          Change passphrase
        </button>
      </form>

      <div className="mb-5">
        {enrollment ? (
          <div className="w-80">
            <TotpEnrollment
              enrollment={enrollment}
              busy={busy}
              onConfirm={(code) =>
                void run(async () => {
                  const result = await finishTotpReenroll(
                    enrollment.enrollmentId,
                    code,
                    signOutOthers,
                  );
                  setEnrollment(null);
                  return `The new authenticator is in use.${signedOut(result.revokedDevices.length)}`;
                })
              }
            />
          </div>
        ) : (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void run(async () => setEnrollment(await startTotpReenroll()))}
          >
            Set up a new authenticator
          </button>
        )}
      </div>

      <div className="mb-5">
        {codes ? (
          <div className="w-80">
            <BackupCodes codes={codes} />
            <button type="button" className={`${BUTTON} mt-2`} onClick={() => setCodes(null)}>
              Done
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setCodes((await regenerateBackupCodes()).backupCodes);
                invalidate(ACCOUNT_KEY);
              })
            }
          >
            Make new backup codes
          </button>
        )}
      </div>

      <button
        type="button"
        className={BUTTON}
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await signOutOtherDevices();
            return `Signed out ${result.revokedDevices.length} other devices.`;
          })
        }
      >
        Sign out all other devices
      </button>
    </section>
  );
}
