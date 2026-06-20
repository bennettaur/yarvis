import { describe, expect, it } from "bun:test";
import type { Task } from "../db/schema.ts";
import type { MemoryRecord } from "./index.ts";
import { chunkText, htmlToText } from "./ingest.ts";
import { assembleRecapContext, dateRange } from "./recap.ts";

describe("ingest chunking", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  it("returns nothing for empty input", () => {
    expect(chunkText("   ")).toEqual([]);
  });

  it("splits long text into bounded chunks on sentence boundaries", () => {
    const sentence = "This is a sentence. ";
    const text = sentence.repeat(20); // ~400 chars
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });

  it("hard-splits a single oversized unit", () => {
    const chunks = chunkText("x".repeat(250), 100);
    expect(chunks.length).toBe(3);
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles, and tags", () => {
    const html =
      "<html><head><style>.a{}</style><script>bad()</script></head><body><p>Hello&nbsp;<b>world</b></p></body></html>";
    expect(htmlToText(html)).toBe("Hello world");
  });
});

describe("recap date range", () => {
  it("day covers since local midnight", () => {
    const now = new Date("2026-05-24T15:30:00");
    const { from, to, label } = dateRange("day", now);
    expect(label).toBe("today");
    expect(from.getHours()).toBe(0);
    expect(from.getDate()).toBe(24);
    expect(to).toBe(now);
  });

  it("week covers since Monday", () => {
    // 2026-05-24 is a Sunday; Monday of that week is the 18th.
    const now = new Date("2026-05-24T15:30:00");
    const { from, label } = dateRange("week", now);
    expect(label).toBe("this week");
    expect(from.getDate()).toBe(18);
  });
});

describe("assembleRecapContext", () => {
  it("lists completed tasks and notes, marking empties", () => {
    const tasks = [{ scope: "daily", title: "Ship PR review", notes: null } as Task];
    const notes = [{ content: "Idea: add recaps" } as MemoryRecord];
    const out = assembleRecapContext(tasks, notes);
    expect(out).toContain("Ship PR review");
    expect(out).toContain("Idea: add recaps");
  });

  it("shows (none) when there is nothing", () => {
    const out = assembleRecapContext([], []);
    expect(out).toContain("Completed tasks:\n  (none)");
    expect(out).toContain("Notes:\n  (none)");
  });
});
