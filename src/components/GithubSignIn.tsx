import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelGithubSignIn,
  type DeviceFlowStart,
  githubSignInStatus,
  startGithubSignIn,
} from "../lib/githubAuth";
import { openExternal } from "../lib/url";

/** GitHub asks for at least 5s between token polls; the sidecar does that part. */
const STATUS_POLL_MS = 2000;

/**
 * "Sign in with GitHub" through the device flow: shows the code to enter and
 * opens GitHub's page for it. The sidecar polls GitHub and saves the token, so
 * this only watches for the outcome.
 */
export function GithubSignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [flow, setFlow] = useState<DeviceFlowStart | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flowId = useRef<string | null>(null);

  const start = useCallback(async () => {
    setMessage(null);
    setBusy(true);
    try {
      const started = await startGithubSignIn();
      flowId.current = started.id;
      setFlow(started);
      openExternal(started.verificationUri);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const cancel = useCallback(() => {
    const id = flowId.current;
    flowId.current = null;
    setFlow(null);
    if (id) void cancelGithubSignIn(id).catch(() => {});
  }, []);

  useEffect(() => {
    if (!flow) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const status = await githubSignInStatus(flow.id);
        if (stopped || status.state === "pending") return;
        stopped = true;
        clearInterval(timer);
        flowId.current = null;
        setFlow(null);
        if (status.state === "authorized") {
          setMessage("Signed in. Restarting the sidecar with the new token…");
          await onSignedIn();
          setMessage("Signed in to GitHub.");
        } else if (status.state === "denied") {
          setMessage("Sign-in was cancelled on GitHub.");
        } else if (status.state === "expired") {
          setMessage("The code expired before it was entered. Try again.");
        } else {
          setMessage(status.error);
        }
      } catch (e) {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        setFlow(null);
        setMessage(e instanceof Error ? e.message : String(e));
      }
    }, STATUS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [flow, onSignedIn]);

  // Leaving Settings mid-sign-in stops the sidecar polling GitHub for nothing.
  useEffect(() => () => cancel(), [cancel]);

  return (
    <div className="mb-2 space-y-2">
      {flow ? (
        <div className="rounded-md border border-zinc-700 bg-zinc-800/60 p-3 text-sm">
          <p className="text-zinc-300">
            Enter this code on GitHub to sign in, then approve Yarvis:
          </p>
          <p className="my-2 font-mono text-lg tracking-widest text-zinc-100">{flow.userCode}</p>
          <div className="flex gap-2">
            <button
              onClick={() => openExternal(flow.verificationUri)}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
            >
              Open GitHub
            </button>
            <button
              onClick={cancel}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">Waiting for you to approve on GitHub…</p>
        </div>
      ) : (
        <button
          onClick={() => void start()}
          disabled={busy}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
        >
          Sign in with GitHub
        </button>
      )}
      {message && <p className="text-xs text-zinc-400">{message}</p>}
    </div>
  );
}
