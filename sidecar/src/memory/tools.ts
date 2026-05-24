import { tool } from "ai";
import { z } from "zod";
import type { MemoryService } from "./index.ts";

/**
 * Memory tools for the chat model: store durable facts the user shares and
 * recall them later by semantic search.
 */
export function buildMemoryTools(memory: MemoryService, sessionId: string) {
  return {
    remember: tool({
      description:
        "Store a durable fact, preference, or note the user shares so it can be recalled in future conversations.",
      inputSchema: z.object({
        content: z.string().describe("The fact to remember, in a self-contained sentence"),
      }),
      execute: async ({ content }) => {
        const record = await memory.add(content, { sessionId });
        return { id: record.id };
      },
    }),

    recall: tool({
      description:
        "Search the user's stored memories for anything relevant to a query.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, limit }) => {
        const results = await memory.search(query, limit ?? 5);
        return results.map((r) => ({
          content: r.content,
          score: r.score,
        }));
      },
    }),
  };
}
