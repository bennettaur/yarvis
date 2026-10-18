import { describe, expect, it } from "bun:test";
import { classify } from "./tier.ts";

const file = (path: string, additions = 10, deletions = 0) => ({ path, additions, deletions });

describe("classify", () => {
  it("treats a small frontend change as low risk", () => {
    expect(classify([file("src/components/Foo.tsx"), file("docs/features/x.md")]).tier).toBe("low");
  });

  it("treats a change to the verifier or CI as high risk, so it can't approve itself", () => {
    expect(classify([file("scripts/verify/gate.ts")]).tier).toBe("high");
    expect(classify([file(".github/workflows/verify.yml")]).tier).toBe("high");
  });

  it("treats secrets, permissions, migrations and dependencies as high risk", () => {
    for (const path of [
      "src-tauri/src/keychain.rs",
      "src-tauri/capabilities/default.json",
      "sidecar/drizzle/0042_new.sql",
      "sidecar/src/agentTools/store.ts",
      "bun.lock",
      "sidecar/package.json",
    ]) {
      expect(classify([file(path)]).tier).toBe("high");
    }
  });

  it("treats sidecar and Rust code as standard risk, but not their tests", () => {
    expect(classify([file("sidecar/src/memory/recall.ts")]).tier).toBe("standard");
    expect(classify([file("src-tauri/src/alarms.rs")]).tier).toBe("standard");
    expect(classify([file("sidecar/src/memory/recall.test.ts")]).tier).toBe("low");
  });

  it("raises the tier by size, counting code but not tests or lockfiles", () => {
    expect(classify([file("src/App.tsx", 301)]).tier).toBe("standard");
    expect(classify([file("src/App.tsx", 500, 301)]).tier).toBe("high");
    expect(classify([file("src/App.tsx", 10), file("src/App.test.tsx", 2000)]).tier).toBe("low");
  });

  it("gives only the reasons for the tier that won", () => {
    const result = classify([file("sidecar/src/memory/recall.ts"), file("bun.lock")]);
    expect(result.tier).toBe("high");
    expect(result.reasons).toEqual(["high: dependencies (bun.lock)"]);
  });
});
