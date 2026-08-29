import { createHash } from "node:crypto";
import { and, cosineDistance, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type AgentToolRow, agentTools } from "../db/schema.ts";
import type { Embedder } from "../memory/embedder.ts";

/**
 * The unified tool registry store: DB operations over the `agent_tools` table,
 * shared by the built-in tool sync ({@link ../agentTools/registry.ts}) and the
 * MCP connection manager. Both write tools here; the chat agent and the Tool
 * Manager UI read from here.
 */

export type ToolPolicy = "always" | "search" | "disabled";
export type ToolSource = "builtin" | "mcp";

/** A tool to upsert into the registry, before policy/embedding are applied. */
export interface ToolDescriptor {
  /**
   * Policy for this tool when it is first inserted, overriding the scope's
   * default. Lets one sync seed some tools always-on and the rest behind search;
   * an existing row's policy is preserved either way.
   */
  defaultPolicy?: ToolPolicy;
  /** "builtin:<name>" or "mcp:<serverId>:<toolName>". */
  id: string;
  source: ToolSource;
  /** The owning MCP server, or null for built-ins. */
  serverId: string | null;
  name: string;
  description: string;
  /** JSON Schema of the tool's input, when known (MCP tools); null otherwise. */
  inputSchema: unknown;
}

/** Identifies the slice of the registry a sync reconciles against. */
export interface SyncScope {
  source: ToolSource;
  /** Required for source "mcp" (the server being synced); null for built-ins. */
  serverId: string | null;
  /** Policy assigned to newly-discovered tools; existing policy is preserved. */
  defaultPolicy: ToolPolicy;
}

/** A registry row as surfaced to the Tool Manager (embedding omitted). */
export type RegistryTool = Omit<AgentToolRow, "embedding">;

/** A search hit: enough to identify and describe a tool to the agent. */
export interface ToolSearchHit {
  id: string;
  name: string;
  source: ToolSource;
  serverId: string | null;
  description: string;
  /** Cosine similarity (0–1). */
  score: number;
}

function contentHash(d: ToolDescriptor): string {
  return createHash("sha256")
    .update(`${d.name}\n${d.description}\n${JSON.stringify(d.inputSchema ?? null)}`)
    .digest("hex");
}

/** The text embedded for semantic tool search: name plus description. */
function embedText(d: ToolDescriptor): string {
  return `${d.name}\n${d.description}`.trim();
}

function scopeFilter(scope: SyncScope): SQL | undefined {
  if (scope.source === "mcp") {
    return and(eq(agentTools.source, "mcp"), eq(agentTools.serverId, scope.serverId as string));
  }
  return eq(agentTools.source, "builtin");
}

/**
 * Reconciles a set of discovered tools into the registry for one scope:
 * inserts new tools (with `defaultPolicy`), re-embeds tools whose
 * name/description/schema changed (preserving their policy), and removes tools
 * that are no longer present. Only new/changed tools are embedded, keyed by
 * `contentHash`, so an unchanged resync makes no embedding calls.
 */
export async function syncToolSet(
  db: Db,
  embedder: Embedder,
  descriptors: ToolDescriptor[],
  scope: SyncScope,
): Promise<{ inserted: number; updated: number; deleted: number }> {
  const existing = await db
    .select({ id: agentTools.id, contentHash: agentTools.contentHash })
    .from(agentTools)
    .where(scopeFilter(scope));
  const existingHashes = new Map(existing.map((r) => [r.id, r.contentHash]));
  const desiredIds = new Set(descriptors.map((d) => d.id));

  // New (no row yet) or changed (hash differs) tools need (re-)embedding.
  const toWrite = descriptors.filter((d) => existingHashes.get(d.id) !== contentHash(d));
  const embeddings = toWrite.length ? await embedder.embedMany(toWrite.map(embedText)) : [];

  let inserted = 0;
  let updated = 0;
  await Promise.all(
    toWrite.map((d, i) => {
      const fields = {
        name: d.name,
        description: d.description,
        inputSchema: d.inputSchema ?? null,
        contentHash: contentHash(d),
        embedding: embeddings[i]!,
      };
      if (existingHashes.has(d.id)) {
        updated += 1;
        return db
          .update(agentTools)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(agentTools.id, d.id));
      }
      inserted += 1;
      return db.insert(agentTools).values({
        id: d.id,
        source: d.source,
        serverId: d.serverId,
        policy: d.defaultPolicy ?? scope.defaultPolicy,
        ...fields,
      });
    }),
  );

  const toDelete = existing.filter((r) => !desiredIds.has(r.id)).map((r) => r.id);
  if (toDelete.length) {
    await db.delete(agentTools).where(inArray(agentTools.id, toDelete));
  }

  return { inserted, updated, deleted: toDelete.length };
}

/** Lists every registry tool (embedding omitted) for the Tool Manager UI. */
export async function listRegistryTools(db: Db): Promise<RegistryTool[]> {
  return db
    .select({
      id: agentTools.id,
      source: agentTools.source,
      serverId: agentTools.serverId,
      name: agentTools.name,
      description: agentTools.description,
      inputSchema: agentTools.inputSchema,
      policy: agentTools.policy,
      contentHash: agentTools.contentHash,
      createdAt: agentTools.createdAt,
      updatedAt: agentTools.updatedAt,
    })
    .from(agentTools)
    .orderBy(agentTools.source, agentTools.name);
}

export async function setToolPolicy(
  db: Db,
  id: string,
  policy: ToolPolicy,
): Promise<RegistryTool | null> {
  const [row] = await db
    .update(agentTools)
    .set({ policy, updatedAt: new Date() })
    .where(eq(agentTools.id, id))
    .returning({
      id: agentTools.id,
      source: agentTools.source,
      serverId: agentTools.serverId,
      name: agentTools.name,
      description: agentTools.description,
      inputSchema: agentTools.inputSchema,
      policy: agentTools.policy,
      contentHash: agentTools.contentHash,
      createdAt: agentTools.createdAt,
      updatedAt: agentTools.updatedAt,
    });
  return row ?? null;
}

/**
 * Semantic search over tools whose policy is "search" — the tools the agent can
 * discover and mount on demand. Mirrors the memory store's pgvector cosine
 * search: orders by ascending distance, returns similarity = 1 - distance.
 */
export async function searchRegistry(
  db: Db,
  embedder: Embedder,
  query: string,
  limit = 5,
): Promise<ToolSearchHit[]> {
  const queryVec = await embedder.embedQuery(query);
  const distance = cosineDistance(agentTools.embedding, queryVec);
  const rows = await db
    .select({
      id: agentTools.id,
      name: agentTools.name,
      source: agentTools.source,
      serverId: agentTools.serverId,
      description: agentTools.description,
      distance,
    })
    .from(agentTools)
    .where(and(eq(agentTools.policy, "search"), isNotNull(agentTools.embedding)))
    .orderBy(distance)
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    source: r.source,
    serverId: r.serverId,
    description: r.description,
    score: 1 - Number(r.distance),
  }));
}

/**
 * Ids of the tools the user has turned off. A narrow read on purpose: the
 * callers that need it run per delegated turn, and `listRegistryTools` pulls
 * every description and JSON schema in the registry to answer the same question.
 */
export async function listDisabledToolIds(db: Db): Promise<{ id: string }[]> {
  return db.select({ id: agentTools.id }).from(agentTools).where(eq(agentTools.policy, "disabled"));
}
