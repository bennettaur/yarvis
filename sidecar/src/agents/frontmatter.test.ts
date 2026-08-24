import { describe, expect, it } from "bun:test";
import { asBoolean, asInteger, asList, FrontmatterError, parseDocument } from "./frontmatter.ts";

const doc = (body: string) => parseDocument("agent.md", body);

describe("frontmatter parsing", () => {
  it("reads scalars, block lists and the body", () => {
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
    expect(parsed.values.name).toBe("work-scout");
    expect(parsed.values.model).toBe("anthropic/claude-sonnet-5");
    expect(parsed.lists.tools).toEqual(["find_dangling_work", "list_workspaces"]);
    expect(parsed.body).toBe("You are a scout.\n\nReport plainly.");
  });

  it("reads an inline list either bracketed or comma-separated", () => {
    expect(doc("---\ntools: [a, b]\n---\nx").lists.tools).toEqual(["a", "b"]);
    expect(asList(doc("---\ntools: a, b,\n---\nx"), "tools")).toEqual(["a", "b"]);
    // A single value is still readable as a list, so `tools: search_events` works.
    expect(asList(doc("---\ntools: search_events\n---\nx"), "tools")).toEqual(["search_events"]);
  });

  /**
   * Prose has commas in it. Splitting on them at parse time turned every
   * description with a clause in it into a list, and the definition then failed
   * to load for "missing description" — with nothing in the file to point at.
   */
  it("keeps a comma in a scalar as punctuation, not a list separator", () => {
    const parsed = doc("---\ndescription: Reads the project, then the tickets.\n---\nbody");
    expect(parsed.values.description).toBe("Reads the project, then the tickets.");
    expect(parsed.lists.description).toBeUndefined();
  });

  it("treats a bare key as an empty list, not an empty string", () => {
    const parsed = doc("---\nname: x\ntools:\n---\nbody");
    expect(parsed.lists.tools).toEqual([]);
    expect(asList(parsed, "tools")).toEqual([]);
  });

  it("folds a '>' block into one line and keeps '|' newlines", () => {
    const folded = doc("---\ndescription: >-\n  first line\n  second line\n---\nbody");
    expect(folded.values.description).toBe("first line second line");
    const literal = doc("---\ndescription: |\n  first line\n  second line\n---\nbody");
    expect(literal.values.description).toBe("first line\nsecond line");
  });

  it("keeps reading keys after a block scalar", () => {
    const parsed = doc("---\ndescription: >-\n  wrapped text\nmaxSteps: 4\n---\nbody");
    expect(parsed.values.description).toBe("wrapped text");
    expect(parsed.values.maxSteps).toBe("4");
  });

  it("ignores comments and blank lines", () => {
    const parsed = doc("---\n# a note\n\nname: x\n---\nbody");
    expect(parsed.values.name).toBe("x");
  });

  it("strips quotes and a BOM, and tolerates CRLF", () => {
    const parsed = parseDocument("agent.md", '﻿---\r\nname: "x"\r\n---\r\nbody\r\n');
    expect(parsed.values.name).toBe("x");
    expect(parsed.body).toBe("body");
  });

  /**
   * Failing loudly is the point: a definition that half-parses is a prompt or a
   * tool list that isn't what the author wrote.
   */
  it("rejects a file with no frontmatter fence", () => {
    expect(() => doc("name: x\n---\nbody")).toThrow(FrontmatterError);
  });

  it("rejects unclosed frontmatter", () => {
    expect(() => doc("---\nname: x\nbody")).toThrow("never closed");
  });

  it("rejects a line that is neither a pair nor a list item", () => {
    expect(() => doc("---\nname: x\njust some prose\n---\nbody")).toThrow("expected 'key: value'");
  });

  it("rejects a list item with no key above it", () => {
    expect(() => doc("---\n  - orphan\n---\nbody")).toThrow("no key above it");
  });

  it("rejects duplicate keys and tabs", () => {
    expect(() => doc("---\nname: a\nname: b\n---\nbody")).toThrow("duplicate key");
    expect(() => doc("---\nname:\n\t- a\n---\nbody")).toThrow("tabs");
  });

  it("names the file and line in the error", () => {
    try {
      doc("---\nname: x\nbroken line here\n---\nbody");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as FrontmatterError).message).toStartWith("agent.md:3:");
    }
  });
});

describe("typed readers", () => {
  it("reads booleans in the forms a person writes them", () => {
    expect(asBoolean(doc("---\nenabled: false\n---\nx"), "enabled", "f")).toBe(false);
    expect(asBoolean(doc("---\nenabled: YES\n---\nx"), "enabled", "f")).toBe(true);
    expect(asBoolean(doc("---\nname: x\n---\nx"), "enabled", "f")).toBeUndefined();
    expect(() => asBoolean(doc("---\nenabled: maybe\n---\nx"), "enabled", "f")).toThrow(
      "must be true or false",
    );
  });

  it("rejects a step budget that isn't a positive whole number", () => {
    expect(asInteger(doc("---\nmaxSteps: 12\n---\nx"), "maxSteps", "f")).toBe(12);
    for (const bad of ["0", "-3", "2.5", "lots"]) {
      expect(() => asInteger(doc(`---\nmaxSteps: ${bad}\n---\nx`), "maxSteps", "f")).toThrow(
        "positive whole number",
      );
    }
  });
});
