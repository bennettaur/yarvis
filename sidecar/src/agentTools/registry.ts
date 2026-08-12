import { buildAttentionTool, newAttentionState } from "../chat/attentionTools.ts";
import { buildTaskTools } from "../chat/tools.ts";
import type { Db } from "../db/client.ts";
import type { Embedder } from "../memory/embedder.ts";
import type { MemoryService } from "../memory/index.ts";
import { buildMemoryTools } from "../memory/tools.ts";
import { syncToolSet, type ToolDescriptor } from "./store.ts";

/**
 * Built-in tools the agent always has access to (subject to per-tool policy).
 * Their descriptors are read straight from the tool factories so the registry
 * can never drift from the actual tool definitions. The factories don't touch
 * their dependencies at construction time (only inside each tool's `execute`),
 * so inert placeholders are safe for reading metadata.
 *
 * The meta tools (search_tools / mount_tools / unmount_tools) are intentionally
 * excluded — they are always present and not user-configurable.
 */
function builtinDescriptors(): ToolDescriptor[] {
  const placeholderDb = undefined as unknown as Db;
  const placeholderMemory = undefined as unknown as MemoryService;
  const sets: Record<string, { description?: unknown }> = {
    ...buildTaskTools(placeholderDb, ""),
    ...buildMemoryTools(placeholderMemory, ""),
    ...buildAttentionTool(newAttentionState()),
  };
  return Object.entries(sets).map(([name, t]) => ({
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
  }));
}

/** Maps a built-in tool's name (its key in the chat tool record) to its
 * registry id, and vice versa. */
export function builtinIdForName(name: string): string {
  return `builtin:${name}`;
}

export function nameForBuiltinId(id: string): string {
  return id.replace(/^builtin:/, "");
}

/**
 * Upserts the built-in tools into the registry, defaulting new ones to "always"
 * (preserving today's behavior where built-ins are always available). Existing
 * rows keep whatever policy the user set. Run on startup and lazily when the
 * registry is read.
 */
export async function syncBuiltins(
  db: Db,
  embedder: Embedder,
): Promise<{ inserted: number; updated: number; deleted: number }> {
  return syncToolSet(db, embedder, builtinDescriptors(), {
    source: "builtin",
    serverId: null,
    defaultPolicy: "always",
  });
}
