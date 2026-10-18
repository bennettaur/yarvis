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

  // Every tool that files or changes a ticket writes where other people see it.
  it("asks before any ticket write, on every tracker", () => {
    const names = Object.keys(builtinToolMetadata());
    for (const name of [
      "jira_create_issue",
      "jira_update_issue",
      "jira_transition_issue",
      "jira_assign_issue",
      "jira_comment_on_issue",
      "create_repo_issue",
      "update_repo_issue",
      "comment_on_repo_issue",
      "azure_boards_create_work_item",
      "azure_boards_update_work_item",
      "azure_boards_assign_work_item",
      "azure_boards_comment_on_work_item",
    ]) {
      expect(names).toContain(name);
      expect(DESTRUCTIVE_BUILTIN_TOOLS.has(name)).toBe(true);
    }
  });
});

describe("ALWAYS_CONFIRM_BUILTIN_TOOLS", () => {
  // A registered repo is one later tools clone and run, and its name may come
  // from injected text, so a typed turn asks too.
  it("asks before registering a repo", () => {
    expect(ALWAYS_CONFIRM_BUILTIN_TOOLS.has("register_repo")).toBe(true);
  });

  // The spoken-turn set adds nothing to a tool that already asks every turn.
  it("does not also list it as destructive", () => {
    expect(DESTRUCTIVE_BUILTIN_TOOLS.has("register_repo")).toBe(false);
  });
});
