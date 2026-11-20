import { describe, expect, it } from "bun:test";
import { ShaCache } from "./cache.ts";

const size = (s: string) => s.length;
const settle = () => Bun.sleep(0);

describe("ShaCache", () => {
  it("shares one load between concurrent requests", async () => {
    const cache = new ShaCache(100);
    let loads = 0;
    const load = async () => {
      loads++;
      await Bun.sleep(5);
      return "value";
    };
    const [a, b] = await Promise.all([cache.get("k", load, size), cache.get("k", load, size)]);
    expect([a, b]).toEqual(["value", "value"]);
    expect(loads).toBe(1);
  });

  it("drops a rejected load so the next request retries", async () => {
    const cache = new ShaCache(100);
    await expect(
      cache.get("k", async () => Promise.reject(new Error("boom")), size),
    ).rejects.toThrow("boom");
    await settle();
    expect(await cache.get("k", async () => "ok", size)).toBe("ok");
  });

  it("evicts the least recently used entries to stay within budget", async () => {
    const cache = new ShaCache(10);
    await cache.get("a", async () => "aaaa", size);
    await cache.get("b", async () => "bbbb", size);
    await settle();
    // Reading `a` makes `b` the least recently used.
    await cache.get("a", async () => "unused", size);
    await cache.get("c", async () => "cccc", size);
    await settle();
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("returns but doesn't keep a value bigger than the budget, and evicts nothing for it", async () => {
    const cache = new ShaCache(10);
    await cache.get("a", async () => "aaaa", size);
    await settle();
    expect(await cache.get("huge", async () => "x".repeat(50), size)).toHaveLength(50);
    await settle();
    expect(cache.has("huge")).toBe(false);
    expect(cache.has("a")).toBe(true);
  });
});
