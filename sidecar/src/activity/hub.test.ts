import { afterEach, describe, expect, it } from "bun:test";
import { type ActivityEvent, reportYarvisActivity, subscribeActivity } from "./hub.ts";

const unsubscribes: (() => void)[] = [];
afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
});

describe("activity hub", () => {
  it("still reaches the other pages when one listener throws", () => {
    const seen: ActivityEvent[] = [];
    unsubscribes.push(
      subscribeActivity(() => {
        throw new Error("broken page");
      }),
      subscribeActivity((event) => seen.push(event)),
    );
    expect(() => reportYarvisActivity("chat", "done", "turn complete")).not.toThrow();
    expect(seen).toEqual([
      { origin: "yarvis", type: "done", source: "chat", label: "turn complete" },
    ]);
  });
});
