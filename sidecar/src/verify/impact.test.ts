import { describe, expect, it } from "bun:test";
import { type ClassifiedChange, changeBand, describeCounts, scoreImpact } from "./impact.ts";

const change = (overrides: Partial<ClassifiedChange> = {}): ClassifiedChange => ({
  kind: "logic",
  reach: "local",
  evidence: "partial",
  ...overrides,
});

describe("changeBand", () => {
  it("keeps a passive change minimal even in core code", () => {
    expect(changeBand(change({ kind: "passive", reach: "core", evidence: "unproven" }))).toBe(1);
  });

  it("scores logic in core code high", () => {
    expect(changeBand(change({ kind: "logic", reach: "core" }))).toBe(4);
  });

  it("scores a reorganization nobody proved as a logic change", () => {
    expect(
      changeBand(change({ kind: "reorganization", reach: "shared", evidence: "proven" })),
    ).toBe(2);
    expect(
      changeBand(change({ kind: "reorganization", reach: "shared", evidence: "partial" })),
    ).toBe(4);
  });

  it("raises an unproven change one band and lowers a proven one, but not below low", () => {
    expect(changeBand(change({ kind: "interface", reach: "shared", evidence: "unproven" }))).toBe(
      4,
    );
    expect(changeBand(change({ kind: "logic", reach: "shared", evidence: "proven" }))).toBe(3);
    expect(changeBand(change({ kind: "logic", reach: "leaf", evidence: "proven" }))).toBe(2);
  });

  it("doesn't let proof lower an interface change, since callers outside the tests may break", () => {
    expect(changeBand(change({ kind: "interface", reach: "core", evidence: "proven" }))).toBe(4);
  });

  it("scores an unproven reorganization as an unproven logic change", () => {
    expect(
      changeBand(change({ kind: "reorganization", reach: "shared", evidence: "unproven" })),
    ).toBe(5);
  });

  it("lowers a proven addition in core code", () => {
    expect(changeBand(change({ kind: "addition", reach: "core", evidence: "proven" }))).toBe(2);
  });

  it("doesn't move a change that behaves as before, even on sensitive ground", () => {
    const sensitive = { sensitive: true, reach: "core" as const };
    expect(changeBand(change({ ...sensitive, kind: "passive" }))).toBe(1);
    expect(changeBand(change({ ...sensitive, kind: "reorganization", evidence: "proven" }))).toBe(
      2,
    );
  });

  it("lets proof and sensitive ground cancel out", () => {
    expect(
      changeBand(change({ kind: "logic", reach: "core", evidence: "proven", sensitive: true })),
    ).toBe(4);
  });

  it("raises sensitive ground one band, up to very high", () => {
    expect(changeBand(change({ kind: "addition", reach: "local", sensitive: true }))).toBe(3);
    expect(
      changeBand(change({ kind: "logic", reach: "core", evidence: "unproven", sensitive: true })),
    ).toBe(5);
  });
});

describe("scoreImpact", () => {
  it("has nothing to score without changes", () => {
    expect(scoreImpact([])).toBeNull();
  });

  it("takes the highest change's band when volume is low", () => {
    const impact = scoreImpact([
      change({ kind: "passive", count: 40 }),
      change({ kind: "logic", reach: "local" }),
    ]);
    expect(impact).toMatchObject({ band: 3, highestChangeBand: 3, load: 2, raisedByVolume: 0 });
    expect(impact?.attention).toEqual([]);
  });

  it("raises many small changes one band", () => {
    const impact = scoreImpact([change({ kind: "addition", reach: "local", count: 10 })]);
    expect(impact).toMatchObject({ band: 3, highestChangeBand: 2, load: 10, raisedByVolume: 1 });
  });

  it("doesn't raise below a load of 8", () => {
    const impact = scoreImpact([change({ kind: "addition", reach: "local", count: 7 })]);
    expect(impact).toMatchObject({ band: 2, load: 7, raisedByVolume: 0 });
  });

  it("raises one band up to a load of 15 and two from 16", () => {
    const at = (count: number) =>
      scoreImpact([change({ kind: "addition", reach: "local", count })]);
    expect(at(15)).toMatchObject({ band: 3, raisedByVolume: 1 });
    expect(at(16)).toMatchObject({ band: 4, highestChangeBand: 2, raisedByVolume: 2 });
  });

  it("never lets volume alone raise a PR past high", () => {
    const impact = scoreImpact([change({ kind: "logic", reach: "local", count: 20 })]);
    expect(impact).toMatchObject({ band: 4, highestChangeBand: 3, load: 40, raisedByVolume: 1 });
  });

  it("makes two high changes very high", () => {
    const core = change({ kind: "logic", reach: "core" });
    const impact = scoreImpact([core, { ...core, kind: "interface" }]);
    expect(impact).toMatchObject({ band: 5, highestChangeBand: 4, load: 8 });
    expect(impact?.attention).toHaveLength(2);
  });

  it("lists changes highest band first", () => {
    const impact = scoreImpact([
      change({ kind: "passive" }),
      change({ kind: "logic", reach: "core" }),
      change({ kind: "addition", reach: "shared" }),
    ]);
    expect(impact?.changes.map((c) => c.band)).toEqual([4, 2, 1]);
  });

  it("counts kinds by each entry's count", () => {
    const impact = scoreImpact([
      change({ kind: "passive", count: 6 }),
      change({ kind: "reorganization", evidence: "proven", count: 2 }),
      change({ kind: "addition" }),
    ]);
    expect(impact && describeCounts(impact.counts)).toBe(
      "6 passive, 2 reorganizations, 1 addition",
    );
  });
});
