import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelGithubSignIn,
  type DeviceFlowStart,
  fetchGithubSignInStatus,
  githubSignInConfigured,
  startGithubSignIn,
} from "../lib/githubAuth";
import { openExternal } from "../lib/url";

/** GitHub asks for at least 5s between token polls; the sidecar does that part. */
const STATUS_POLL_MS = 2000;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * "Sign in with GitHub" through the device flow: shows the code to enter and
 * opens GitHub's page for it. The sidecar polls GitHub and saves the token, so
 * this only watches for the outcome.
 */
export function GithubSignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [configured, setConfigured] = useState(false);
  const [flow, setFlow] = useState<DeviceFlowStart | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flowId = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    githubSignInConfigured()
      .then((value) => {
        if (mounted.current) setConfigured(value);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    setMessage(null);
    setBusy(true);
    try {
      const started = await startGithubSignIn();
      if (!mounted.current) {
        void cancelGithubSignIn(started.id).catch(() => {});
        return;
      }
      flowId.current = started.id;
      setFlow(started);
      openExternal(started.verificationUri);
    } catch (e) {
      if (mounted.current) setMessage(errorText(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const cancel = useCallback(() => {
    const id = flowId.current;
    flowId.current = null;
    if (mounted.current) setFlow(null);
    if (id) void cancelGithubSignIn(id).catch(() => {});
  }, []);

  // One status request at a time: the next is scheduled only after the last
  // answers, so a slow sidecar can't run the outcome (and its restart) twice.
  useEffect(() => {
    if (!flow) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const finish = async (outcome: () => Promise<string>) => {
      active = false;
      flowId.current = null;
      setFlow(null);
      try {
        setMessage(await outcome());
      } catch (e) {
        setMessage(errorText(e));
      }
    };

    const check = async () => {
      let status: Awaited<ReturnType<typeof fetchGithubSignInStatus>>;
      try {
        status = await fetchGithubSignInStatus(flow.id);
      } catch (e) {
        if (active) await finish(async () => errorText(e));
        return;
      }
      if (!active) return;
      switch (status.state) {
        case "pending":
          timer = setTimeout(check, STATUS_POLL_MS);
          return;
        case "authorized": {
          const who = status.login ? ` as ${status.login}` : "";
          setMessage(`Signed in${who}. Restarting the sidecar with the new token…`);
          await finish(async () => {
            try {
              await onSignedIn();
            } catch (e) {
              return `Signed in${who}, but restarting the sidecar failed: ${errorText(e)}`;
            }
            return `Signed in to GitHub${who}.`;
          });
          return;
        }
        case "denied":
          await finish(async () => "Sign-in was cancelled on GitHub.");
          return;
        case "expired":
          await finish(async () => "The code expired before it was entered. Try again.");
          return;
        case "failed":
          await finish(async () => status.error);
          return;
      }
    };

    timer = setTimeout(check, STATUS_POLL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [flow, onSignedIn]);

  // Leaving Settings mid-sign-in stops the sidecar polling GitHub for nothing.
  useEffect(() => () => cancel(), [cancel]);

  if (!configured) return null;

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
              type="button"
              onClick={() => openExternal(flow.verificationUri)}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
            >
              Open GitHub
            </button>
            <button
              type="button"
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
          type="button"
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
