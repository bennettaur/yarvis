import { useEffect, useRef, useState } from "react";
import { setCodePrompter } from "../../lib/auth";
import { cleanCode } from "./TotpEnrollment";

/**
 * Asks for a code from the authenticator app when the server wants a recent
 * one (`reauth_required`). `withFreshCode` in `lib/auth` calls it, checks the
 * code, and retries the action once.
 */
export default function CodePrompt() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const answer = useRef<((code: string | null) => void) | null>(null);

  useEffect(
    () =>
      setCodePrompter(
        () =>
          new Promise<string | null>((resolve) => {
            // A second request while one is open cancels the first.
            answer.current?.(null);
            answer.current = resolve;
            setCode("");
            setOpen(true);
          }),
      ),
    [],
  );

  const close = (value: string | null) => {
    answer.current?.(value);
    answer.current = null;
    setOpen(false);
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        role="dialog"
        aria-label="Enter a code"
        className="flex w-72 flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-5 text-zinc-100"
        onSubmit={(e) => {
          e.preventDefault();
          close(cleanCode(code));
        }}
      >
        <p className="text-sm text-zinc-300">
          Enter the code your authenticator app shows to confirm it's you.
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Code"
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            disabled={cleanCode(code).length !== 6}
          >
            Confirm
          </button>
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            onClick={() => close(null)}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
