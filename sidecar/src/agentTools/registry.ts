import { builtinToolMetadataByFamily } from "../chat/builtinTools.ts";
import type { Db } from "../db/client.ts";
import type { Embedder } from "../memory/embedder.ts";
import { syncToolSet, type ToolDescriptor, type ToolPolicy } from "./store.ts";

/**
 * Built-in tools the agent always has access to (subject to per-tool policy).
 * Their descriptors are read straight from the shared tool builder in
 * `chat/builtinTools.ts`, so the registry can never drift from what a turn
 * actually gets — and a built-in can't end up assembled-but-never-active,
 * which is what happens to one the registry doesn't know about (the active set
 * is computed from registry policy).
 *
 * The meta tools (search_tools / mount_tools / unmount_tools) are intentionally
 * excluded — they are always present and not user-configurable.
 */
/**
 * Which families are worth carrying in every turn's context, and which the agent
 * should have to reach for.
 *
 * The always-on set is what a planning or capture turn uses constantly — the
 * user's tasks, memory, their projects, the assistant's todos, the activity log,
 * the planner, and delegation. The rest are situational and bulky: a workspace
 * flow, a JIRA query, an in-flight review, the calendar. Those seed at `search`,
 * so `search_tools` + `mount_tools` brings them in for the turn that needs them.
 *
 * This matters beyond token cost — 57 tool schemas in front of a model measurably
 * degrades which one it picks. A family absent from this map defaults to `search`,
 * so a new one is opt-in to always-on rather than silently added to every turn.
 */
const FAMILY_POLICY: Record<string, ToolPolicy> = {
  tasks: "always",
  memory: "always",
  attention: "always",
  projects: "always",
  todos: "always",
  events: "always",
  digest: "always",
  delegation: "always",
  workspaces: "search",
  jira: "search",
  prReview: "search",
  calendar: "search",
};

function builtinDescriptors(): ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = [];
  for (const [family, tools] of Object.entries(builtinToolMetadataByFamily())) {
    for (const [name, t] of Object.entries(tools)) {
      descriptors.push({
        id: `builtin:${name}`,
        source: "builtin" as const,
        serverId: null,
        name,
        // A tool's description may be a function of the calling context. The
        // registry indexes tools ahead of any call and has no context to supply,
        // so only fixed descriptions are embeddable; the built-ins all use those.
        description: typeof t.description === "string" ? t.description : "",
        // Built-in execution uses the real factory tool, not the registry schema,
        // so a JSON Schema copy isn't needed here.
        inputSchema: null,
        defaultPolicy: FAMILY_POLICY[family] ?? "search",
      });
    }
  }
  return descriptors;
}

/**
 * Maps between a built-in tool's name — what an agent definition file writes —
 * and its registry id.
 */
export function builtinIdForName(name: string): string {
  return `builtin:${name}`;
}

export function nameForBuiltinId(id: string): string {
  return id.replace(/^builtin:/, "");
}

/**
 * Upserts the built-in tools into the registry, each seeded with its family's
 * policy. Existing rows keep whatever policy the user set. Run on startup and
 * lazily when the registry is read.
 */
export async function syncBuiltins(
  db: Db,
  embedder: Embedder,
): Promise<{ inserted: number; updated: number; deleted: number }> {
  return syncToolSet(db, embedder, builtinDescriptors(), {
    source: "builtin",
    serverId: null,
    // Per-descriptor policy above decides; this is the fallback for a family the
    // map doesn't name.
    defaultPolicy: "search",
  });
}
