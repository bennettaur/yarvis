import { describe, expect, it } from "bun:test";
import type { EventRow } from "../db/schema.ts";
import { parseSessionDigest, transcriptMaterial } from "./ccSessions.ts";
import { eventMaterial, previousDay } from "./consolidate.ts";

const event = (over: Partial<EventRow>): EventRow =>
  ({
    id: "e1",
    type: "pr.approved",
    source: "github",
    payload: { ref: "gh:me/app/1" },
    occurredAt: new Date("2026-08-24T14:35:00Z"),
    processedAt: null,
    createdAt: new Date("2026-08-24T14:35:00Z"),
    ...over,
  }) as EventRow;

describe("event material", () => {
  it("renders one line per event with its time, type and payload", () => {
    const material = eventMaterial([
      event({}),
      event({ id: "e2", type: "task.completed", source: null, payload: { title: "ship it" } }),
    ]);
    expect(material.split("\n")).toEqual([
      '2026-08-24 14:35 pr.approved (github) {"ref":"gh:me/app/1"}',
      '2026-08-24 14:35 task.completed {"title":"ship it"}',
    ]);
  });

  it("handles an event with no payload", () => {
    expect(eventMaterial([event({ payload: null })])).toBe("2026-08-24 14:35 pr.approved (github)");
  });
});

describe("previous day window", () => {
  it("covers local midnight to midnight of the day before", () => {
    const { from, to, label } = previousDay(new Date("2026-08-24T03:10:00"));
    expect(label).toBe("2026-08-23");
    expect(from.getHours()).toBe(0);
    expect(to.getDate() - from.getDate()).toBe(1);
  });
});

describe("session digest parsing", () => {
  it("splits the three labelled sections", () => {
    const digest = parseSessionDigest(
      [
        "WORK: Added the pgvector index and fixed the migration.",
        "DECISIONS: Kept the 1536-dim column because re-embedding is expensive.",
        "FEEDBACK: Stop adding comments that restate the code.",
      ].join("\n"),
    );
    expect(digest.work).toBe("Added the pgvector index and fixed the migration.");
    expect(digest.decisions).toContain("1536-dim");
    expect(digest.feedback).toBe("Stop adding comments that restate the code.");
  });

  it("reads 'none' as an absent section", () => {
    const digest = parseSessionDigest("WORK: Ran the tests.\nDECISIONS: none\nFEEDBACK: none");
    expect(digest.decisions).toBeNull();
    expect(digest.feedback).toBeNull();
  });

  it("keeps multi-line sections intact", () => {
    const digest = parseSessionDigest(
      "WORK: First line.\nSecond line.\nDECISIONS: Chose Postgres.\nFEEDBACK: none",
    );
    expect(digest.work).toBe("First line.\nSecond line.");
    expect(digest.decisions).toBe("Chose Postgres.");
  });

  it("falls back to the whole answer when the model ignored the headers", () => {
    const digest = parseSessionDigest("The session refactored the memory store.");
    expect(digest.work).toBe("The session refactored the memory store.");
    expect(digest.decisions).toBeNull();
  });
});

describe("transcript material", () => {
  it("drops empty turns and labels the rest by role", () => {
    const material = transcriptMaterial([
      { role: "user", text: "add the index", timestamp: null },
      { role: "assistant", text: "   ", timestamp: null },
      { role: "assistant", text: "done", timestamp: null },
    ]);
    expect(material).toBe("user: add the index\n\nassistant: done");
  });

  it("keeps both ends of a transcript too long to send whole", () => {
    const long = transcriptMaterial([
      { role: "user", text: `START ${"x".repeat(30_000)} END`, timestamp: null },
    ]);
    expect(long).toContain("START");
    expect(long).toContain("END");
    expect(long).toContain("(middle omitted)");
  });
});
