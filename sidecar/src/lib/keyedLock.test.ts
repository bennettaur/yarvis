import { describe, expect, it } from "bun:test";
import { createKeyedLock } from "./keyedLock.ts";

describe("createKeyedLock", () => {
  it("runs work under one key in order, and other keys alongside", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    const step = (name: string, ms: number) => async () => {
      order.push(`${name} start`);
      await Bun.sleep(ms);
      order.push(`${name} end`);
      return name;
    };
    const results = await Promise.all([
      lock("a", step("a1", 20)),
      lock("a", step("a2", 1)),
      lock("b", step("b1", 1)),
    ]);
    expect(results).toEqual(["a1", "a2", "b1"]);
    expect(order.indexOf("a2 start")).toBeGreaterThan(order.indexOf("a1 end"));
    expect(order.indexOf("b1 end")).toBeLessThan(order.indexOf("a1 end"));
  });

  it("keeps going after a failure", async () => {
    const lock = createKeyedLock();
    const failed = lock("a", async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    expect(await lock("a", async () => "next")).toBe("next");
  });
});
