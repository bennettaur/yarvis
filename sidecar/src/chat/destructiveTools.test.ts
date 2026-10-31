import { describe, expect, it } from "bun:test";
import { builtinToolMetadata, builtinToolMetadataByFamily } from "./builtinTools.ts";
import {
  ALWAYS_CONFIRM_BUILTIN_TOOLS,
  conditionalConfirmations,
  DESTRUCTIVE_BUILTIN_TOOLS,
  newUntrustedReads,
} from "./destructiveTools.ts";

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

  // A task spends money and writes files; checking on one does neither.
  it("asks before handing a task to Claude Code, and not before checking on one", () => {
    const names = Object.keys(builtinToolMetadata());
    expect(names).toEqual(
      expect.arrayContaining(["start_claude_code_task", "get_claude_code_task"]),
    );
    expect(DESTRUCTIVE_BUILTIN_TOOLS.has("start_claude_code_task")).toBe(true);
    expect(DESTRUCTIVE_BUILTIN_TOOLS.has("get_claude_code_task")).toBe(false);
  });

  // Every tool that files or changes a ticket writes where other people see it.
  // Walking the families rather than naming the writes means a new write tool
  // that was never added to the set fails here instead of running unasked.
  it("asks before any ticket write, on every tracker, and not before a read", () => {
    const families = builtinToolMetadataByFamily();
    const reads = new Set([
      "get_repo_issue",
      "azure_boards_search",
      "azure_boards_get_work_item",
      "azure_boards_list_work_item_types",
      "jira_search_issues",
      "jira_get_issue",
    ]);
    const names = ["githubIssues", "azureBoards", "jira"].flatMap((f) =>
      Object.keys(families[f] ?? {}),
    );
    expect(names.length).toBeGreaterThan(reads.size);
    for (const name of names) {
      const asks = DESTRUCTIVE_BUILTIN_TOOLS.has(name) || ALWAYS_CONFIRM_BUILTIN_TOOLS.has(name);
      expect([name, asks]).toEqual([name, !reads.has(name)]);
    }
  });
});

describe("ALWAYS_CONFIRM_BUILTIN_TOOLS", () => {
  // A registered repo is one later tools clone and run, and its name may come
  // from injected text, so a typed turn asks too.
  it("asks before registering a repo", () => {
    expect(ALWAYS_CONFIRM_BUILTIN_TOOLS.has("register_repo")).toBe(true);
  });

  // Yarvis's own repo is public and not one the user registered.
  it("asks before filing an issue on Yarvis itself", () => {
    expect(ALWAYS_CONFIRM_BUILTIN_TOOLS.has("file_yarvis_issue")).toBe(true);
  });

  // The spoken-turn set adds nothing to a tool that already asks every turn.
  it("does not also list it as destructive", () => {
    expect(DESTRUCTIVE_BUILTIN_TOOLS.has("register_repo")).toBe(false);
  });
});

describe("conditionalConfirmations", () => {
  const given = (url: string) => url === "https://given.test/";

  it("asks before destructive tools only once a typed turn has read a web page", () => {
    const reads = newUntrustedReads();
    const conditions = conditionalConfirmations({ spoken: false, reads, isUserGivenUrl: given });
    const deleteTask = conditions.get("delete_task");
    expect(deleteTask?.({})).toBe(false);
    reads.hasReadWebPage = true;
    expect(deleteTask?.({})).toBe(true);
  });

  it("leaves destructive tools to the always-ask set on a spoken turn", () => {
    const conditions = conditionalConfirmations({
      spoken: true,
      reads: newUntrustedReads(),
      isUserGivenUrl: given,
    });
    expect(conditions.has("delete_task")).toBe(false);
  });

  it("asks before reading a URL the user didn't give", () => {
    const conditions = conditionalConfirmations({
      spoken: false,
      reads: newUntrustedReads(),
      isUserGivenUrl: given,
    });
    const readPage = conditions.get("read_web_page");
    expect(readPage?.({ url: "https://given.test/" })).toBe(false);
    expect(readPage?.({ url: "https://evil.test/?q=memories" })).toBe(true);
    expect(readPage?.({})).toBe(true);
  });

  it("names tools that exist", () => {
    const names = Object.keys(builtinToolMetadata());
    const conditions = conditionalConfirmations({
      spoken: false,
      reads: newUntrustedReads(),
      isUserGivenUrl: given,
    });
    for (const name of conditions.keys()) expect(names).toContain(name);
  });
});
