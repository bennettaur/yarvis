import { describe, expect, it } from "bun:test";
import { asSchema, type Tool } from "ai";
import type { Db } from "../db/client.ts";
import { buildPassTools, type PassOutcome } from "../headsDown/passTools.ts";
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
  it("never use tuple-form items", async () => {
    const tools: Record<string, Tool> = {
      ...builtinToolMetadata(),
      ...buildPassTools(
        undefined as unknown as Db,
        {} as PassOutcome,
        () => {},
        new Set(),
        [],
        undefined,
        [],
        { alwaysOn: true },
      ),
    };
    const offenders: string[] = [];
    for (const [name, t] of Object.entries(tools)) {
      const json = await asSchema(t.inputSchema).jsonSchema;
      offenders.push(...tupleItemsPaths(json).map((p) => `${name}: ${p}`));
    }
    expect(offenders).toEqual([]);
  });
});
