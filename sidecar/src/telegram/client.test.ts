import { describe, expect, it } from "bun:test";
import { splitMessage, TELEGRAM_MAX_MESSAGE } from "./client.ts";

describe("splitMessage", () => {
  it("returns a single chunk when within the limit", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("returns one (empty) chunk for empty input", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  it("splits oversized text into limit-sized chunks", () => {
    const text = "a".repeat(TELEGRAM_MAX_MESSAGE + 100);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= TELEGRAM_MAX_MESSAGE)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers breaking on a newline rather than mid-line", () => {
    const head = "x".repeat(10);
    const text = `${head}\n${"z".repeat(20)}`;
    const chunks = splitMessage(text, 15);
    // The break lands on the newline (which is consumed), keeping the first
    // line intact rather than cutting it at the 15-char limit.
    expect(chunks[0]).toBe(head);
    expect(chunks.every((c) => c.length <= 15)).toBe(true);
  });

  it("hard-slices a single line longer than the limit", () => {
    const text = "q".repeat(40);
    const chunks = splitMessage(text, 15);
    expect(chunks).toEqual(["q".repeat(15), "q".repeat(15), "q".repeat(10)]);
  });
});
