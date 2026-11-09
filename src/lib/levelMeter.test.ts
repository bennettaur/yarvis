import { describe, expect, it } from "bun:test";
import { createLevelMeter } from "./levelMeter";

describe("createLevelMeter", () => {
  it("tells subscribers about each change, but not a repeat of the same level", () => {
    const meter = createLevelMeter();
    let changes = 0;
    meter.subscribe(() => changes++);

    meter.set(0.4);
    meter.set(0.4);
    meter.set(0);

    expect(changes).toBe(2);
    expect(meter.get()).toBe(0);
  });

  it("stops telling a subscriber once it unsubscribes", () => {
    const meter = createLevelMeter(0.2);
    let changes = 0;
    const unsubscribe = meter.subscribe(() => changes++);
    unsubscribe();
    meter.set(0.5);
    expect(changes).toBe(0);
  });
});
