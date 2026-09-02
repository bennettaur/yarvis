import { useCallback, useEffect, useMemo, useState } from "react";
import { type DisplayError, formatError } from "../lib/errors";
import {
  listAgentTools,
  listMcpServers,
  type McpServer,
  type RegistryTool,
  setToolSettings,
  type ToolApproval,
  type ToolPolicy,
} from "../lib/mcp";
import ErrorNotice from "./ErrorNotice";

/**
 * The unified Tool Manager: lists every tool the agent can use — built-in and
 * MCP-sourced — grouped by source, and lets the user set each tool's policy
 * (always mounted, available via search, or disabled) and, for MCP tools,
 * whether calling one asks first. Changes take effect on the next chat turn; no
 * restart needed.
 *
 * Auto-approval is offered for MCP tools only. A built-in's confirmation is
 * decided by how the turn was composed — a spoken turn was never proof-read —
 * which is not something a stored preference should be able to waive.
 */
export default function ToolManagerSection() {
  const [tools, setTools] = useState<RegistryTool[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [error, setError] = useState<DisplayError | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [registry, mcpServers] = await Promise.all([listAgentTools(), listMcpServers()]);
      setTools(registry);
      setServers(mcpServers);
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const change = useCallback(
    async (id: string, settings: { policy?: ToolPolicy; approval?: ToolApproval }) => {
      try {
        const updated = await setToolSettings(id, settings);
        setTools((prev) => prev.map((t) => (t.id === id ? updated : t)));
      } catch (e) {
        setError(formatError(e));
      }
    },
    [],
  );

  const setServerApproval = useCallback(
    async (serverTools: RegistryTool[], approval: ToolApproval) => {
      for (const t of serverTools) {
        if (t.approval !== approval) await change(t.id, { approval });
      }
    },
    [change],
  );

  const groups = useMemo(() => {
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    const builtins = tools.filter((t) => t.source === "builtin");
    const byServer = new Map<string, RegistryTool[]>();
    for (const t of tools) {
      if (t.source !== "mcp" || !t.serverId) continue;
      const list = byServer.get(t.serverId) ?? [];
      list.push(t);
      byServer.set(t.serverId, list);
    }
    const mcpGroups = [...byServer.entries()].map(([serverId, list]) => ({
      title: serverName.get(serverId) ?? "Unknown server",
      tools: list,
    }));
    return { builtins, mcpGroups };
  }, [tools, servers]);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Tool manager
      </h2>
      <p className="mb-4 text-xs text-zinc-500">
        Control how each tool is exposed to the agent. <strong>Always</strong> keeps it in context;{" "}
        <strong>Search</strong> makes it discoverable on demand; <strong>Disabled</strong> hides it.
        An MCP tool asks before every call unless you mark it <strong>Auto</strong>.
      </p>

      {error && <ErrorNotice error={error} onDismiss={() => setError(null)} className="mb-3" />}

      {tools.length === 0 ? (
        <p className="text-xs text-zinc-500">No tools registered yet.</p>
      ) : (
        <div className="space-y-5">
          <ToolGroup title="Built-in" tools={groups.builtins} onChange={change} />
          {groups.mcpGroups.map((g) => (
            <ToolGroup
              key={g.title}
              title={g.title}
              tools={g.tools}
              onChange={change}
              onApproveAll={(approval) => void setServerApproval(g.tools, approval)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ToolGroup({
  title,
  tools,
  onChange,
  onApproveAll,
}: {
  title: string;
  tools: RegistryTool[];
  onChange: (id: string, settings: { policy?: ToolPolicy; approval?: ToolApproval }) => void;
  /** Present for MCP groups: sets every tool on the server at once. */
  onApproveAll?: (approval: ToolApproval) => void;
}) {
  if (tools.length === 0) return null;
  const allAuto = tools.every((t) => t.approval === "auto");
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</span>
        {onApproveAll && (
          <button
            type="button"
            onClick={() => onApproveAll(allAuto ? "ask" : "auto")}
            className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            {allAuto ? "Ask for every tool" : "Auto-approve every tool"}
          </button>
        )}
      </div>
      <div className="space-y-2">
        {tools.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate text-sm text-zinc-100">{t.name}</div>
              {t.description && (
                <div className="truncate text-xs text-zinc-500">{t.description}</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {t.source === "mcp" && (
                <select
                  value={t.approval}
                  aria-label={`Approval for ${t.name}`}
                  onChange={(e) => onChange(t.id, { approval: e.target.value as ToolApproval })}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none focus:border-zinc-500"
                >
                  <option value="ask">Ask</option>
                  <option value="auto">Auto</option>
                </select>
              )}
              <select
                value={t.policy}
                aria-label={`Policy for ${t.name}`}
                onChange={(e) => onChange(t.id, { policy: e.target.value as ToolPolicy })}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none focus:border-zinc-500"
              >
                <option value="always">Always</option>
                <option value="search">Search</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
