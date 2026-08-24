import { describe, expect, it } from "bun:test";
import type { EventRow } from "../db/schema.ts";
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
