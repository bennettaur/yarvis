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
      "Cargo.toml",
      ".claude/skills/verify-pr/SKILL.md",
      ".claude/settings.json",
      "CLAUDE.md",
      "AGENTS.md",
      "lefthook.yml",
      "bunfig.toml",
      "sidecar/bunfig.toml",
      "vite.config.ts",
      "sidecar/src/app.ts",
      "extension/page.js",
      "src-tauri/tauri.release.conf.json",
    ]) {
      expect(classify([file(path)]).tier).toBe("high");
    }
  });

  it("presumes nothing about an area: frontend, sidecar and Rust code all start low", () => {
    // What the change does decides the rest, in the report's signed assessment.
    for (const path of ["src/App.tsx", "sidecar/src/memory/recall.ts", "src-tauri/src/alarms.rs"]) {
      expect(classify([file(path)]).tier).toBe("low");
    }
  });

  it("raises the tier by size, counting code but not tests or lockfiles", () => {
    expect(classify([file("src/App.tsx", 301)]).tier).toBe("standard");
    expect(classify([file("src/App.tsx", 500, 301)]).tier).toBe("high");
    expect(classify([file("src/App.tsx", 10), file("src/App.test.tsx", 2000)]).tier).toBe("low");
  });

  it("keeps the verifier's own tests high risk", () => {
    expect(classify([file("scripts/verify/gate.test.ts")]).tier).toBe("high");
  });

  it("counts test preloads and helpers as code toward size, not as tests", () => {
    expect(classify([file("sidecar/src/test/setup.ts", 301)]).tier).toBe("standard");
  });

  it("classifies the old path of a renamed file", () => {
    const moved = {
      path: "src/lib/store.ts",
      previousPath: "sidecar/src/agentTools/store.ts",
      additions: 0,
      deletions: 0,
    };
    expect(classify([moved]).tier).toBe("high");
  });

  it("groups many files under one reason", () => {
    const result = classify([file("scripts/verify/a.ts"), file("scripts/verify/b.ts")]);
    expect(result.reasons).toEqual(["the verification layer itself (2 files)"]);
  });

  it("gives only the reasons for the tier that won", () => {
    const result = classify([file("sidecar/src/memory/recall.ts"), file("bun.lock")]);
    expect(result.tier).toBe("high");
    expect(result.reasons).toEqual(["dependencies (bun.lock)"]);
  });
});
