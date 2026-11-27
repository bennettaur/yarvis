import { describe, expect, it } from "bun:test";
import { asSchema, type Tool } from "ai";
import type { Db } from "../db/client.ts";
import { buildPassTools, newPassOutcome } from "../headsDown/passTools.ts";
import { builtinToolMetadata } from "./builtinTools.ts";

/** JSON paths where `items` is a list, the draft-07 tuple form. */
function tupleItemsPaths(schema: unknown, path = "$"): string[] {
  if (Array.isArray(schema)) return schema.flatMap((s, i) => tupleItemsPaths(s, `${path}[${i}]`));
  if (!schema || typeof schema !== "object") return [];
  return Object.entries(schema).flatMap(([key, value]) => [
    ...(key === "items" && Array.isArray(value) ? [`${path}.items`] : []),
    ...tupleItemsPaths(value, `${path}.${key}`),
  ]);
}

describe("tool input schemas", () => {
  // Bedrock requires JSON Schema 2020-12, where `items` must be a schema, and
  // LiteLLM's Gemini mapping crashes on a list there. The AI SDK writes a
  // `z.tuple` as a list, so a tuple anywhere in a tool's input breaks every
  // turn on those providers.
  // Covers the built-ins and the heads-down pass tools, the sets a chat turn or
  // a pass sends. Other tool sets (PR tours, specialists) aren't walked.
  it("never use tuple-form items", async () => {
    // Building a tool never touches the database; only running one does.
    const unusedDb = undefined as unknown as Db;
    const tools: Record<string, Tool> = {
      ...builtinToolMetadata(),
      // alwaysOn adds create_routine.
      ...buildPassTools(unusedDb, newPassOutcome(), () => {}, new Set(), [], undefined, [], {
        alwaysOn: true,
      }),
    };
    const offenders: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      const inputJsonSchema = await asSchema(tool.inputSchema).jsonSchema;
      offenders.push(...tupleItemsPaths(inputJsonSchema).map((p) => `${name}: ${p}`));
    }
    expect(offenders).toEqual([]);
  });
});
