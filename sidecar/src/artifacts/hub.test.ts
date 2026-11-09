import { describe, expect, it } from "bun:test";
import { type ArtifactChange, publishArtifactChange, subscribeArtifact } from "./hub.ts";

describe("artifact hub", () => {
  it("tells every open pane, and stops telling one once it unsubscribes", () => {
    const seenA: ArtifactChange[] = [];
    const seenB: ArtifactChange[] = [];
    const stopA = subscribeArtifact("one", (c) => seenA.push(c));
    const stopB = subscribeArtifact("one", (c) => seenB.push(c));
    publishArtifactChange("one", "updated");
    stopA();
    publishArtifactChange("one", "deleted");
    stopB();
    publishArtifactChange("one", "updated");
    expect(seenA).toEqual(["updated"]);
    expect(seenB).toEqual(["updated", "deleted"]);
  });

  it("keeps a failing listener from stopping the write or the others", () => {
    const seen: ArtifactChange[] = [];
    const stopBad = subscribeArtifact("two", () => {
      throw new Error("closed");
    });
    const stopGood = subscribeArtifact("two", (c) => seen.push(c));
    expect(() => publishArtifactChange("two", "updated")).not.toThrow();
    expect(seen).toEqual(["updated"]);
    stopBad();
    stopGood();
  });

  it("only tells listeners of the artifact that changed", () => {
    const seen: ArtifactChange[] = [];
    const stop = subscribeArtifact("three", (c) => seen.push(c));
    publishArtifactChange("other", "updated");
    expect(seen).toEqual([]);
    stop();
  });
});
