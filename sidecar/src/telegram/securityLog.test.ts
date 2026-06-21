import { describe, expect, it } from "bun:test";
import { SecurityLog } from "./securityLog.ts";

describe("SecurityLog", () => {
  it("assigns monotonic sequence numbers", () => {
    const log = new SecurityLog();
    log.add("unlock", 1, 1000);
    log.add("failed", 1, 1000); // same ts on purpose
    const events = log.since(0);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(["unlock", "failed"]);
  });

  it("returns only events with a sequence strictly greater than `since`", () => {
    const log = new SecurityLog();
    log.add("unlock", 1, 1000);
    log.add("failed", 1, 1001);
    expect(log.since(1).map((e) => e.type)).toEqual(["failed"]);
    expect(log.since(2)).toEqual([]);
  });

  it("does not drop same-millisecond events across a cursor advance", () => {
    const log = new SecurityLog();
    log.add("failed", 1, 5000);
    const first = log.since(0);
    const cursor = Math.max(...first.map((e) => e.seq));
    log.add("lockout", 1, 5000); // same ts as the prior event
    const second = log.since(cursor);
    expect(second.map((e) => e.type)).toEqual(["lockout"]);
  });

  it("evicts oldest events past the cap but keeps sequence numbers advancing", () => {
    const log = new SecurityLog();
    for (let i = 0; i < 105; i++) log.add("failed", 1, i);
    const events = log.since(0);
    expect(events).toHaveLength(100);
    // Oldest five (seq 1-5) evicted; newest retained with its high seq.
    expect(events[0]!.seq).toBe(6);
    expect(events.at(-1)!.seq).toBe(105);
  });
});
