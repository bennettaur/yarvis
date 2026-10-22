import { describe, expect, it } from "bun:test";
import { ModelCache } from "./modelCache";

class FakeModel {
  disposed = false;
  constructor(readonly name: string) {}
  dispose() {
    this.disposed = true;
  }
}

describe("ModelCache", () => {
  it("shares one model between holders of the same key", () => {
    const cache = new ModelCache<FakeModel>();
    const a = cache.acquire("x", () => new FakeModel("first"));
    const b = cache.acquire("x", () => new FakeModel("second"));
    expect(b).toBe(a);
    expect(cache.size).toBe(1);
  });

  it("keeps a model while anyone still holds it", () => {
    const cache = new ModelCache<FakeModel>(0);
    const model = cache.acquire("x", () => new FakeModel("x"));
    cache.acquire("x", () => new FakeModel("unused"));
    cache.release("x");
    expect(model.disposed).toBe(false);
    cache.release("x");
    expect(model.disposed).toBe(true);
    expect(cache.peek("x")).toBeUndefined();
  });

  it("keeps the most recently released models and disposes older ones", () => {
    const cache = new ModelCache<FakeModel>(2);
    const models = ["a", "b", "c"].map((key) => cache.acquire(key, () => new FakeModel(key)));
    for (const key of ["a", "b", "c"]) cache.release(key);
    expect(models.map((m) => m.disposed)).toEqual([true, false, false]);
    expect(cache.size).toBe(2);
  });

  it("revives an idle model instead of making a new one", () => {
    const cache = new ModelCache<FakeModel>(1);
    const first = cache.acquire("a", () => new FakeModel("a"));
    cache.release("a");
    expect(cache.acquire("a", () => new FakeModel("again"))).toBe(first);
    // Held again, so another release does not push it out.
    cache.acquire("b", () => new FakeModel("b"));
    cache.release("b");
    expect(first.disposed).toBe(false);
  });

  it("ignores a release with nothing held", () => {
    const cache = new ModelCache<FakeModel>(0);
    const model = cache.acquire("a", () => new FakeModel("a"));
    cache.release("a");
    cache.release("a");
    cache.release("never");
    expect(model.disposed).toBe(true);
  });

  it("forgets a model disposed elsewhere", () => {
    const cache = new ModelCache<FakeModel>();
    cache.acquire("a", () => new FakeModel("a"));
    cache.forget("a");
    const fresh = cache.acquire("a", () => new FakeModel("fresh"));
    expect(fresh.name).toBe("fresh");
  });
});
