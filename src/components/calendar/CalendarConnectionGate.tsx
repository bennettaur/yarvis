import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type CalendarStatus, calAuthUrl, calStatus } from "../../lib/calendar";
import { openExternal } from "../../lib/url";

/**
 * Gates calendar views behind a connected Google Calendar. Renders its children
 * only once the integration is both configured and connected; otherwise it
 * shows the same configure / connect messaging the agenda used to carry inline.
 * Each view wraps itself in this gate so it works standalone as an Omni widget.
 *
 * Children may be a render function to receive `reload`, which re-checks the
 * connection — used by the agenda's "Disconnect" so the connect screen reappears
 * without a full reload.
 */
export default function CalendarConnectionGate({
  children,
}: {
  children: ReactNode | ((ctx: { reload: () => void }) => ReactNode);
}) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await calStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const connect = useCallback(async () => {
    try {
      const { url } = await calAuthUrl();
      openExternal(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  if (!status) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  if (!status.configured) {
    return (
      <div className="space-y-2 text-sm text-zinc-400">
        <p>
          Google Calendar isn't configured. Add a Google Cloud OAuth client (Desktop app) under{" "}
          <b>Settings → Google client id / secret</b> to connect your calendar.
        </p>
        <p className="text-xs text-zinc-600">
          The redirect URI to register is{" "}
          <code className="rounded bg-zinc-800 px-1">
            http://127.0.0.1:&lt;sidecar-port&gt;/oauth/google/callback
          </code>{" "}
          (loopback; any port is accepted for Desktop clients).
        </p>
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">
          Connect your Google Calendar to see upcoming meetings and arm alarms for them.
        </p>
        <button
          onClick={() => void connect()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >
          Connect Google Calendar
        </button>
        <button
          onClick={() => void loadStatus()}
          className="ml-2 text-sm text-zinc-500 hover:text-zinc-300"
        >
          I've connected — refresh
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <>{typeof children === "function" ? children({ reload: () => void loadStatus() }) : children}</>
  );
}
