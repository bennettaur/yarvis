import { useMcpConnectionIssues } from "../lib/useMcpConnectionIssues";

/**
 * Above a chat's composer: which MCP servers can't serve tools right now, with
 * the button that fixes each one without leaving the chat. Renders nothing when
 * every enabled server is healthy. `visible` is for a host that keeps the chat
 * mounted while it is off screen (Omni Chat), so it doesn't poll unseen.
 */
export default function McpConnectionBar({ visible = true }: { visible?: boolean }) {
  const { issues, authorize, reconnect } = useMcpConnectionIssues(visible);
  if (issues.length === 0) return null;

  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-sm"
    >
      {issues.map(({ server, kind, working, error }) => (
        <div key={server.id} className="flex flex-wrap items-center gap-2">
          <p className="flex-1 text-amber-200">
            <span className="font-medium">{server.name}</span>
            {kind === "authorize" ? " needs you to sign in." : " is not connected."}
            {error && <span className="ml-1 text-red-300">{error}</span>}
          </p>
          <button
            type="button"
            disabled={working}
            onClick={() =>
              void (kind === "authorize" ? authorize(server.id) : reconnect(server.id))
            }
            className="rounded-md border border-amber-800 px-2 py-1 text-xs text-amber-100 hover:bg-amber-900/40 disabled:opacity-50"
          >
            {working ? "Working…" : kind === "authorize" ? "Sign in" : "Reconnect"}
          </button>
        </div>
      ))}
    </div>
  );
}
