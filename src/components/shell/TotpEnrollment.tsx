import { useState } from "react";
import type { Enrollment } from "../../lib/auth";
import { writeClipboard } from "../../lib/clipboard";

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100";
const BUTTON =
  "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50";

/** A 6-digit code, with the spaces some apps show between groups taken out. */
export const cleanCode = (code: string) => code.replace(/\s/g, "");

/**
 * A new TOTP secret to add to an authenticator app, as a QR code and as text,
 * and the first code that proves the app has it.
 */
export function TotpEnrollment({
  enrollment,
  busy,
  onConfirm,
}: {
  enrollment: Enrollment;
  busy: boolean;
  onConfirm: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const qr = `data:image/svg+xml;utf8,${encodeURIComponent(enrollment.qrSvg)}`;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(cleanCode(code));
      }}
    >
      <p className="text-sm text-zinc-400">
        Scan this with an authenticator app (1Password, Google Authenticator, Authy…), or enter the
        key by hand.
      </p>
      <img
        src={qr}
        alt="QR code for your authenticator app"
        className="mx-auto h-48 w-48 rounded-md bg-white p-2"
      />
      <code className="break-all rounded-md bg-zinc-900 px-2 py-1 text-center text-xs text-zinc-300">
        {enrollment.secret}
      </code>
      <label className="text-xs text-zinc-400">
        <span className="mb-1 block uppercase tracking-wide">Code from the app</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          className={INPUT}
        />
      </label>
      <button type="submit" className={BUTTON} disabled={busy || cleanCode(code).length !== 6}>
        {busy ? "Checking…" : "Confirm"}
      </button>
    </form>
  );
}

/** Backup codes, shown once, with a button that copies them all. */
export function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-zinc-400">
        Save these backup codes somewhere safe. Each signs in once in place of a code from the app.
        They won't be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-1 rounded-md bg-zinc-900 p-3 font-mono text-sm text-zinc-200">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <button
        type="button"
        className="self-start rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        onClick={() => {
          void writeClipboard(codes.join("\n")).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy codes"}
      </button>
    </div>
  );
}
