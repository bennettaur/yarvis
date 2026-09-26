import { useCallback, useEffect, useRef, useState } from "react";
import {
  authorizeMcpServer,
  getMcpServerStatus,
  listMcpServers,
  type McpServer,
  refreshMcpServer,
} from "./mcp";
import { openExternal } from "./url";

/** Why an enabled server can't serve tools right now, and so what fixes it. */
export type McpIssueKind = "authorize" | "reconnect";

export interface McpConnectionIssue {
  server: McpServer;
  kind: McpIssueKind;
  /** The fix is running: waiting on the browser, or on a reconnect. */
  working: boolean;
  /** What the last attempt at the fix said, when it didn't work. */
  error: string | null;
}

const RECHECK_INTERVAL_MS = 60_000;
const AUTHORIZE_POLL_INTERVAL_MS = 2_000;
const AUTHORIZE_POLL_ATTEMPTS = 60;

type Found = Pick<McpConnectionIssue, "server" | "kind">;

/**
 * Enabled servers that are not serving tools: an OAuth server with no usable
 * authorization needs the user to sign in, anything else that isn't connected
 * needs another attempt. A server whose status can't be read is left out — the
 * sidecar being unreachable is the chat's own error to report, not this
 * banner's.
 */
async function findIssues(): Promise<Found[]> {
  const servers = (await listMcpServers()).filter((s) => s.enabled);
  const found = await Promise.all(
    servers.map(async (server): Promise<Found | null> => {
      try {
        const status = await getMcpServerStatus(server.id);
        if (server.oauth && !status.oauth?.authorized) return { server, kind: "authorize" };
        if (!status.connected) return { server, kind: "reconnect" };
        return null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((f): f is Found => f !== null);
}

/**
 * The MCP servers a chat surface should flag, with the actions to fix them in
 * place. Rechecked on mount, on a timer, and whenever the window regains focus —
 * a token expiring or a server dropping doesn't announce itself, and the user
 * usually finds out by asking for something the tool can't do. A surface that
 * stays mounted while hidden passes `active: false` so it stops polling, and
 * rechecks the moment it is shown again.
 */
export function useMcpConnectionIssues(active = true): {
  issues: McpConnectionIssue[];
  authorize: (serverId: string) => Promise<void>;
  reconnect: (serverId: string) => Promise<void>;
} {
  const [found, setFound] = useState<Found[]>([]);
  const [working, setWorking] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Only the latest check may land: an older one can finish after a fix has
  // already cleared the server and would put it back.
  const checkId = useRef(0);
  const mounted = useRef(true);

  const check = useCallback(async () => {
    const id = ++checkId.current;
    try {
      const next = await findIssues();
      if (mounted.current && id === checkId.current) setFound(next);
    } catch {
      // Sidecar not up yet, or MCP not configured (no database): nothing to flag.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void check();
    // A backgrounded window skips its tick; the focus handler catches up.
    const timer = setInterval(() => {
      if (!document.hidden) void check();
    }, RECHECK_INTERVAL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, check]);

  const run = useCallback(
    async (serverId: string, action: () => Promise<void>) => {
      setWorking((prev) => ({ ...prev, [serverId]: true }));
      setErrors((prev) => {
        const { [serverId]: _cleared, ...rest } = prev;
        return rest;
      });
      try {
        await action();
      } catch (e) {
        if (mounted.current) {
          setErrors((prev) => ({
            ...prev,
            [serverId]: e instanceof Error ? e.message : String(e),
          }));
        }
      } finally {
        if (mounted.current) setWorking((prev) => ({ ...prev, [serverId]: false }));
        await check();
      }
    },
    [check],
  );

  /**
   * Opens the sign-in page, then waits for the sidecar's callback route to
   * finish the exchange. A status read that fails mid-wait is not the end of it:
   * the user may well be signing in, so keep watching until the attempts run out.
   */
  const signIn = useCallback(async (serverId: string) => {
    const { authorizationUrl } = await authorizeMcpServer(serverId);
    openExternal(authorizationUrl);
    for (let i = 0; i < AUTHORIZE_POLL_ATTEMPTS && mounted.current; i++) {
      await new Promise((resolve) => setTimeout(resolve, AUTHORIZE_POLL_INTERVAL_MS));
      try {
        if ((await getMcpServerStatus(serverId)).oauth?.authorized) return;
      } catch {
        // Transient; try again.
      }
    }
    if (mounted.current) throw new Error("Sign-in didn't complete.");
  }, []);

  const authorize = useCallback(
    (serverId: string) => run(serverId, () => signIn(serverId)),
    [run, signIn],
  );

  const reconnect = useCallback(
    (serverId: string) =>
      run(serverId, async () => {
        const result = await refreshMcpServer(serverId);
        // A 401 on refresh means the token is gone: hand off to the sign-in flow.
        if (result.needsAuthorization) return signIn(serverId);
        if (!result.connected) throw new Error(result.error ?? "Could not connect");
      }),
    [run, signIn],
  );

  const issues = found.map((f) => ({
    ...f,
    working: working[f.server.id] ?? false,
    error: errors[f.server.id] ?? null,
  }));

  return { issues, authorize, reconnect };
}
