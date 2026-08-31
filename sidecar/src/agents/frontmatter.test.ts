import { describe, expect, it } from "bun:test";
import {
  asBoolean,
  asInteger,
  asList,
  asRequiredString,
  asString,
  assertKnownKeys,
  FrontmatterError,
  parseDocument,
} from "./frontmatter.ts";

const doc = (body: string) => parseDocument("agent.md", body);

describe("splitting a definition", () => {
  it("reads the frontmatter mapping and the body", () => {
    const parsed = doc(
      [
        "---",
        "name: work-scout",
        "model: anthropic/claude-sonnet-5",
        "tools:",
        "  - find_dangling_work",
        "  - list_workspaces",
        "---",
        "",
        "You are a scout.",
        "",
        "Report plainly.",
      ].join("\n"),
    );
    expect(parsed.data.name).toBe("work-scout");
    expect(parsed.data.model).toBe("anthropic/claude-sonnet-5");
    expect(parsed.data.tools).toEqual(["find_dangling_work", "list_workspaces"]);
    expect(parsed.body).toBe("You are a scout.\n\nReport plainly.");
  });

  it("handles the YAML an author actually writes", () => {
    // Folded and literal blocks, flow sequences, comments, quotes — all free now
    // that a real parser owns this.
    const parsed = doc(
      [
        "---",
        "# what this is for",
        'name: "release-notes"',
        "description: >-",
        "  Turns a week of merged PRs into release notes,",
        "  grouped by theme.",
        "tools: [work_summary, recall]",
        "enabled: yes",
        "maxSteps: 6",
        "---",
        "You write release notes.",
      ].join("\n"),
    );
    expect(parsed.data.name).toBe("release-notes");
    expect(parsed.data.description).toBe(
      "Turns a week of merged PRs into release notes, grouped by theme.",
    );
    expect(parsed.data.tools).toEqual(["work_summary", "recall"]);
    // `yes` is a string in YAML 1.2, not a boolean — `asBoolean` is what turns
    // it into one.
    expect(asBoolean("agent.md", parsed.data, "enabled")).toBe(true);
    expect(parsed.data.maxSteps).toBe(6);
  });

  /**
   * The bug that ended the hand-rolled parser: prose has commas in it, and a
   * description that became a list failed to load for "missing description" with
   * nothing in the file to point at.
   */
  it("keeps a comma in prose as punctuation", () => {
    const parsed = doc("---\ndescription: Reads the project, then the tickets.\n---\nbody");
    expect(parsed.data.description).toBe("Reads the project, then the tickets.");
  });

  it("strips a BOM and tolerates CRLF", () => {
    const parsed = parseDocument("agent.md", '﻿---\r\nname: "x"\r\n---\r\nbody\r\n');
    expect(parsed.data.name).toBe("x");
    expect(parsed.body).toBe("body");
  });

  it("rejects a file with no frontmatter fence", () => {
    expect(() => doc("name: x\n---\nbody")).toThrow("frontmatter fence");
  });

  it("rejects unclosed frontmatter", () => {
    expect(() => doc("---\nname: x\nbody")).toThrow("never closed");
  });

  it("rejects frontmatter that isn't a mapping", () => {
    expect(() => doc("---\n- a\n- b\n---\nbody")).toThrow("must be a mapping");
    expect(() => doc("---\n\n---\nbody")).toThrow("is empty");
  });

  it("reports a YAML syntax error against a line in the file, not the block", () => {
    try {
      doc("---\nname: x\n  bad: indent\n---\nbody");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FrontmatterError);
      // The parser blames the line the construct started on — file line 2 here,
      // which is block line 1. What matters is that it is a line in the file.
      expect((e as FrontmatterError).message).toStartWith("agent.md:2:");
      expect((e as FrontmatterError).message).toContain("Nested mappings");
    }
  });
});

describe("validating what came back", () => {
  const data = { name: "x", tools: ["a"], maxSteps: 4, enabled: false };

  it("rejects a key this format has no meaning for", () => {
    // The mistake worth catching: nothing downstream would look wrong.
    expect(() => assertKnownKeys("f.md", { tool: "recall" }, ["tools"])).toThrow(
      "unknown key(s): tool",
    );
    expect(() =>
      assertKnownKeys("f.md", data, ["name", "tools", "maxSteps", "enabled"]),
    ).not.toThrow();
  });

  it("requires the strings that carry meaning", () => {
    expect(asRequiredString("f.md", data, "name")).toBe("x");
    expect(() => asRequiredString("f.md", {}, "name")).toThrow("'name' is required");
    expect(() => asRequiredString("f.md", { name: "   " }, "name")).toThrow("'name' is required");
    expect(() => asRequiredString("f.md", { name: 7 }, "name")).toThrow("must be text");
  });

  it("reads a list from a sequence or a comma-separated string", () => {
    expect(asList("f.md", { tools: ["a", "b"] }, "tools")).toEqual(["a", "b"]);
    expect(asList("f.md", { tools: "a, b," }, "tools")).toEqual(["a", "b"]);
    expect(asList("f.md", { tools: "search_events" }, "tools")).toEqual(["search_events"]);
    expect(asList("f.md", { tools: null }, "tools")).toBeUndefined();
    expect(asList("f.md", {}, "tools")).toBeUndefined();
  });

  it("rejects a list that isn't made of text", () => {
    expect(() => asList("f.md", { tools: [1, 2] }, "tools")).toThrow("item 1 must be text");
    expect(() => asList("f.md", { tools: { a: 1 } }, "tools")).toThrow("must be a list");
  });

  it("reads optional text, treating blank as absent", () => {
    expect(asString("f.md", { model: " a/b " }, "model")).toBe("a/b");
    expect(asString("f.md", { model: "  " }, "model")).toBeUndefined();
    expect(() => asString("f.md", { model: 3 }, "model")).toThrow("must be text");
  });

  it("reads booleans and the yes/no spellings, and rejects anything else", () => {
    expect(asBoolean("f.md", data, "enabled")).toBe(false);
    expect(asBoolean("f.md", {}, "enabled")).toBeUndefined();
    for (const [written, expected] of [
      ["yes", true],
      ["NO", false],
      ["true", true],
      ["off", false],
    ] as const) {
      expect(asBoolean("f.md", { enabled: written }, "enabled")).toBe(expected);
    }
    expect(() => asBoolean("f.md", { enabled: "maybe" }, "enabled")).toThrow(
      "must be true or false",
    );
    expect(() => asBoolean("f.md", { enabled: 1 }, "enabled")).toThrow("must be true or false");
  });

  it("rejects a step budget that isn't a positive whole number", () => {
    expect(asInteger("f.md", data, "maxSteps")).toBe(4);
    for (const bad of [0, -3, 2.5, "lots"]) {
      expect(() => asInteger("f.md", { maxSteps: bad }, "maxSteps")).toThrow(
        "positive whole number",
      );
    }
  });
});
