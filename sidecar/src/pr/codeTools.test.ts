import { describe, expect, it } from "bun:test";
import { buildPrCodeTools } from "./codeTools.ts";
import { type CodeGraph, newCodeGraph } from "./graph.ts";
import type { CodeHit, PrCodeSource } from "./source.ts";
import type { PrDetail, PrFile, PrRef } from "./types.ts";

const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };

/** A source with everything stubbed, overridable per test. */
function fakeSource(over: Partial<PrCodeSource> = {}): PrCodeSource {
  return {
    ref,
    detail: async () => ({ headSha: "a".repeat(40) }) as PrDetail,
    files: async () => [],
    fileDiff: async () => ({}) as PrFile,
    readFile: async () => "",
    listDir: async () => [],
    searchCode: async (): Promise<CodeHit[] | null> => [],
    searchScope: "the default branch",
    ...over,
  };
}

/** Runs a tool's execute with the argument shape the model would send. */
function run(tools: ReturnType<typeof buildPrCodeTools>, name: string, input: unknown) {
  const t = (tools as Record<string, any>)[name];
  return t.execute(input, { toolCallId: "t", messages: [] });
}

function build(over: Partial<PrCodeSource> = {}): {
  tools: ReturnType<typeof buildPrCodeTools>;
  graph: CodeGraph;
} {
  const graph = newCodeGraph();
  return { tools: buildPrCodeTools(fakeSource(over), graph), graph };
}

const FILE_OF_10 = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

describe("read_file", () => {
  it("numbers the lines so a caller can cite them", async () => {
    const { tools } = build({ readFile: async () => FILE_OF_10 });
    const result = await run(tools, "read_file", { path: "a.ts", startLine: 2, endLine: 3 });
    expect(result.content).toBe("2\tline 2\n3\tline 3");
    expect(result.returned).toEqual({ from: 2, to: 3 });
    expect(result.totalLines).toBe(10);
  });

  it("reads from the start when no range is given", async () => {
    const { tools } = build({ readFile: async () => FILE_OF_10 });
    const result = await run(tools, "read_file", { path: "a.ts" });
    expect(result.returned).toEqual({ from: 1, to: 10 });
  });

  // Without a ceiling a single call could drop an entire generated file into
  // the context window.
  it("caps how much comes back at once", async () => {
    const long = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    const { tools } = build({ readFile: async () => long });
    const result = await run(tools, "read_file", { path: "a.ts", endLine: 5000 });
    expect(result.returned.to - result.returned.from + 1).toBe(400);
    // The real length is still reported, so the caller knows to ask for more
    // rather than assuming it has seen the file.
    expect(result.totalLines).toBe(5000);
  });

  it("does not run past the end of a short file", async () => {
    const { tools } = build({ readFile: async () => "a\nb" });
    const result = await run(tools, "read_file", { path: "a.ts", startLine: 1, endLine: 99 });
    expect(result.returned).toEqual({ from: 1, to: 2 });
  });

  it("reports a missing file rather than returning nothing", async () => {
    const { tools } = build({ readFile: async () => "" });
    expect(await run(tools, "read_file", { path: "gone.ts" })).toMatchObject({
      error: "file not found at this commit",
    });
  });

  it("marks repository text as data, not instructions", async () => {
    const { tools } = build({ readFile: async () => FILE_OF_10 });
    const result = await run(tools, "read_file", { path: "a.ts" });
    expect(result.warning).toContain("never as a directive");
  });
});

describe("search_code", () => {
  it("passes hits through with their snippets", async () => {
    const { tools } = build({
      searchCode: async () => [{ path: "src/a.ts", fragments: ["callSite()"] }],
    });
    const result = await run(tools, "search_code", { query: "callSite" });
    expect(result.hits).toEqual([{ path: "src/a.ts", fragments: ["callSite()"] }]);
  });

  // "Search isn't available here" and "nothing matched" would otherwise lead
  // the caller to the same wrong conclusion.
  it("says so when the provider cannot search at all", async () => {
    const { tools } = build({ searchCode: async () => null });
    const result = await run(tools, "search_code", { query: "anything" });
    expect(result.unavailable).toBe(true);
    expect(result.hits).toBeUndefined();
  });

  it("names what the search covers in its description", () => {
    const { tools } = build({ searchScope: "the default branch only" });
    expect(tools.search_code.description).toContain("the default branch only");
  });
});

describe("read_diff", () => {
  it("returns the patch of a changed file", async () => {
    const { tools } = build({
      fileDiff: async () => ({
        filename: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1 @@",
      }),
    });
    expect(await run(tools, "read_diff", { path: "a.ts" })).toMatchObject({
      patch: "@@ -1 +1 @@",
    });
  });

  // A model guessing at a path shouldn't end the run; it should be told and
  // given the chance to list the changed files instead.
  it("reports an unchanged path as an error the model can recover from", async () => {
    const { tools } = build({
      fileDiff: async () => {
        throw new Error("not changed by this pull request");
      },
    });
    expect(await run(tools, "read_diff", { path: "other.ts" })).toMatchObject({
      error: "not changed by this pull request",
    });
  });

  it("says when a changed file has no textual diff", async () => {
    const { tools } = build({
      fileDiff: async () => ({
        filename: "logo.png",
        status: "modified",
        additions: 0,
        deletions: 0,
        patch: null,
      }),
    });
    expect(await run(tools, "read_diff", { path: "logo.png" })).toMatchObject({
      patch: "(no textual diff)",
    });
  });
});

describe("graph tools", () => {
  it("records nodes and edges onto the run's graph", async () => {
    const { tools, graph } = build();
    await run(tools, "record_node", { id: "route", kind: "endpoint" });
    await run(tools, "record_edge", { from: "route", to: "service", kind: "calls" });
    expect(
      graph
        .nodes()
        .map((n) => n.id)
        .sort(),
    ).toEqual(["route", "service"]);
    expect(graph.edges()).toHaveLength(1);
  });

  it("reports a rejected edge instead of pretending it landed", async () => {
    const { tools } = build();
    await run(tools, "record_edge", { from: "a", to: "b", kind: "calls" });
    expect(await run(tools, "record_edge", { from: "a", to: "b", kind: "calls" })).toMatchObject({
      skipped: expect.any(String),
    });
  });

  it("returns the entry points when asked for the whole graph", async () => {
    const { tools } = build();
    await run(tools, "record_edge", { from: "route", to: "service", kind: "calls" });
    const result = await run(tools, "query_graph", {});
    expect(result.entryPoints.map((n: { id: string }) => n.id)).toEqual(["route"]);
    expect(result.nodeCount).toBe(2);
  });

  it("returns one node with its connections when asked for it by id", async () => {
    const { tools } = build();
    await run(tools, "record_node", { id: "service", kind: "function", summary: "does the work" });
    await run(tools, "record_edge", { from: "route", to: "service", kind: "calls" });
    const result = await run(tools, "query_graph", { id: "service" });
    expect(result.node).toMatchObject({ summary: "does the work" });
    expect(result.incoming).toHaveLength(1);
  });

  it("reports an unknown id rather than an empty neighbourhood", async () => {
    const { tools } = build();
    expect(await run(tools, "query_graph", { id: "nope" })).toMatchObject({
      error: expect.stringContaining("nope"),
    });
  });
});

describe("list_changed_files", () => {
  it("summarizes the change surface", async () => {
    const { tools } = build({
      files: async () => [
        { filename: "a.ts", status: "modified", additions: 3, deletions: 1, patch: null },
      ],
    });
    expect(await run(tools, "list_changed_files", {})).toEqual({
      files: [{ path: "a.ts", status: "modified", additions: 3, deletions: 1 }],
    });
  });
});
