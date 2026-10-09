import { describe, expect, it } from "bun:test";
import { builtinToolMetadata } from "./builtinTools.ts";
import { ALWAYS_CONFIRM_BUILTIN_TOOLS, DESTRUCTIVE_BUILTIN_TOOLS } from "./destructiveTools.ts";

describe("DESTRUCTIVE_BUILTIN_TOOLS", () => {
  // A name in the set that no tool has would confirm nothing.
  it("names tools that exist", () => {
    const names = Object.keys(builtinToolMetadata());
    expect(names).toContain("add_repo_to_workspace");
    expect(names).toContain("register_repo");
  });

  it("asks before adding a repo to a workspace", () => {
    expect(DESTRUCTIVE_BUILTIN_TOOLS.has("add_repo_to_workspace")).toBe(true);
  });

  // It only saves a row after the exists check; no repo code runs.
  it("does not ask before registering a repo", () => {
    expect(DESTRUCTIVE_BUILTIN_TOOLS.has("register_repo")).toBe(false);
    expect(ALWAYS_CONFIRM_BUILTIN_TOOLS.has("register_repo")).toBe(false);
  });
});
