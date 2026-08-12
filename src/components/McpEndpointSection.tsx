import { useEffect, useState } from "react";
import { writeClipboard } from "../lib/clipboard";
import { getMcpEndpoint, type McpEndpoint } from "../lib/mcp";

/** The `claude mcp add` invocation that registers this endpoint by hand. */
function claudeAddCommand(endpoint: McpEndpoint): string {
  return `claude mcp add --transport http yarvis ${endpoint.url} --header "Authorization: Bearer ${endpoint.token}"`;
}

/**
 * The MCP server Yarvis serves, as opposed to the ones it connects out to.
 * Sessions Yarvis launches are wired up during workspace provisioning (a
 * `.mcp.json` at the workspace root, resolved against the session's env), so
 * this section exists for a client Yarvis did not spawn — Claude Code in some
 * other terminal, or another editor — which needs the address and token typed
 * in once.
 *
 * The token is masked until asked for: it grants read and write access to the
 * user's memory, and this screen is the kind of thing that ends up in a
 * screenshot.
 */
export default function McpEndpointSection() {
  const [endpoint, setEndpoint] = useState<McpEndpoint | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMcpEndpoint()
      .then(setEndpoint)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const copy = async () => {
    if (!endpoint) return;
    try {
      await writeClipboard(claudeAddCommand(endpoint));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Yarvis MCP endpoint
      </h2>
      <p className="mb-4 text-xs text-zinc-500">
        Yarvis serves its memory tools over MCP, so Claude Code can recall and store memories.
        Sessions Yarvis launches are configured automatically. Point another client here to give it
        the same access — the token is scoped to this endpoint and changes each time Yarvis
        restarts.
      </p>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {endpoint && (
        <div className="space-y-3">
          <div className="text-xs text-zinc-400">
            <span className="mb-1 block uppercase tracking-wide">URL</span>
            <code className="block rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200">
              {endpoint.url}
            </code>
          </div>

          <div className="text-xs text-zinc-400">
            <span className="mb-1 block uppercase tracking-wide">Token</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200">
                {revealed ? endpoint.token : "•".repeat(32)}
              </code>
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                aria-pressed={revealed}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                {revealed ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={copy}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {copied ? "Copied" : "Copy claude mcp add command"}
          </button>
        </div>
      )}
    </section>
  );
}
