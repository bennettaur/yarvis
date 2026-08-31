import { describe, expect, it } from "bun:test";
import { builtinToolMetadata, builtinToolMetadataByFamily } from "../chat/builtinTools.ts";
import { nameForBuiltinId } from "./registry.ts";

describe("built-in tool registry", () => {
  /**
   * The active tool set is computed from registry policy, so a built-in the
   * registry doesn't know about is assembled into the turn and then never
   * offered to the model. Every family therefore has to appear here.
   */
  it("covers every family of built-in tool", () => {
    const names = Object.keys(builtinToolMetadata());
    for (const name of [
      "create_task",
      "remember",
      "request_attention",
      "list_repos",
      "jira_get_issue",
      "list_pr_reviews",
      "upsert_project",
      "create_todo",
      "search_events",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("gives every built-in a description to embed", () => {
    for (const [name, t] of Object.entries(builtinToolMetadata())) {
      expect(typeof t.description, `${name} needs a fixed description`).toBe("string");
      expect((t.description as string).length).toBeGreaterThan(20);
    }
  });

  it("round-trips a built-in id", () => {
    expect(nameForBuiltinId("builtin:create_todo")).toBe("create_todo");
  });

  it("puts every tool in exactly one family, and every family in the flat set", () => {
    const families = builtinToolMetadataByFamily();
    const flat = Object.keys(builtinToolMetadata());
    const grouped = Object.values(families).flatMap((tools) => Object.keys(tools));
    expect(grouped.sort()).toEqual([...flat].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});
