import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listAgentTools,
  listMcpServers,
  type McpServer,
  type RegistryTool,
  setToolPolicy,
  type ToolPolicy,
} from "../lib/mcp";

/**
 * The unified Tool Manager: lists every tool the agent can use — built-in and
 * MCP-sourced — grouped by source, and lets the user set each tool's policy
 * (always mounted, available via search, or disabled). Policy changes take
 * effect on the next chat turn; no restart needed.
 */
export default function ToolManagerSection() {
  const [tools, setTools] = useState<RegistryTool[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [registry, mcpServers] = await Promise.all([listAgentTools(), listMcpServers()]);
      setTools(registry);
      setServers(mcpServers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const changePolicy = useCallback(async (id: string, policy: ToolPolicy) => {
    try {
      const updated = await setToolPolicy(id, policy);
      setTools((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

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
      </p>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {tools.length === 0 ? (
        <p className="text-xs text-zinc-500">No tools registered yet.</p>
      ) : (
        <div className="space-y-5">
          <ToolGroup title="Built-in" tools={groups.builtins} onChange={changePolicy} />
          {groups.mcpGroups.map((g) => (
            <ToolGroup key={g.title} title={g.title} tools={g.tools} onChange={changePolicy} />
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
}: {
  title: string;
  tools: RegistryTool[];
  onChange: (id: string, policy: ToolPolicy) => void;
}) {
  if (tools.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</div>
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
            <select
              value={t.policy}
              onChange={(e) => onChange(t.id, e.target.value as ToolPolicy)}
              className="shrink-0 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none focus:border-zinc-500"
            >
              <option value="always">Always</option>
              <option value="search">Search</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
