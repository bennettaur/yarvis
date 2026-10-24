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

  it("treats the merge reviewer's half of the verifier as high risk", () => {
    for (const path of [
      "sidecar/src/verify/tools.ts",
      "sidecar/src/agents/definitions/merge-reviewer.md",
      "sidecar/src/agents/run.ts",
      "sidecar/src/chat/destructiveTools.ts",
      "sidecar/src/lib/fencing.ts",
      "sidecar/src/github/client.ts",
      "src-tauri/src/sidecar.rs",
    ]) {
      expect(classify([file(path)]).tier).toBe("high");
    }
    expect(classify([file("sidecar/src/agents/definitions/planner.md")]).tier).toBe("standard");
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

describe("the floor's tripwires on added lines", () => {
  const changed = (path: string, addedText: string | null) => ({
    path,
    additions: 1,
    deletions: 0,
    addedText,
  });

  it("raises anything that runs a process, in any area", () => {
    for (const [path, text] of [
      ["src/components/Foo.tsx", 'import { spawnSync } from "node:child_process";'],
      ["sidecar/src/memory/recall.ts", "Bun.spawn(['git', 'status'])"],
      ["src-tauri/src/alarms.rs", 'let out = Command::new("say").arg("hi").output();'],
    ] as const) {
      expect(classify([changed(path, text)]).reasons).toEqual([`runs a process (${path})`]);
    }
  });

  it("raises a call to a command that writes a secret or reaches a shell", () => {
    for (const text of [
      'invoke("set_secret", { key, value })',
      'invoke<void>("pty_write", { id, data })',
    ]) {
      expect(classify([changed("src/lib/x.ts", text)]).tier).toBe("high");
    }
  });

  it("raises a change to what runs without asking", () => {
    expect(
      classify([changed("src/lib/x.ts", 'setToolSettings(id, { approval: "auto" })')]).tier,
    ).toBe("high");
  });

  it("puts reading secrets, outside URLs and deletes at standard", () => {
    expect(
      classify([changed("sidecar/src/x.ts", "const t = config.secrets?.githubToken;")]).tier,
    ).toBe("standard");
    expect(classify([changed("src/lib/x.ts", 'fetch("https://api.example.com/v1")')]).tier).toBe(
      "standard",
    );
    expect(classify([changed("sidecar/src/x.ts", "rmSync(dir, { recursive: true })")]).tier).toBe(
      "standard",
    );
  });

  it("leaves a plain UI change low", () => {
    expect(
      classify([changed("src/components/Foo.tsx", '<div className="p-2">{title}</div>')]).tier,
    ).toBe("low");
  });

  it("can't scan a diff GitHub didn't send, so counts it as standard", () => {
    expect(classify([changed("sidecar/src/big.ts", null)]).reasons).toEqual([
      "a diff too big to scan (sidecar/src/big.ts)",
    ]);
  });

  it("skips tests and files that aren't source", () => {
    expect(classify([changed("src/a.test.ts", "Bun.spawn(['x'])")]).tier).toBe("low");
    expect(classify([changed("docs/x.md", "eval(")]).tier).toBe("low");
  });
});

describe("the floor's paths", () => {
  it("covers the files that store secrets, run commands, or decide what runs unasked", () => {
    for (const path of [
      "src-tauri/src/mcp.rs",
      "src-tauri/src/custom_providers.rs",
      "sidecar/src/workspaces/exec.ts",
      "sidecar/src/workspaces/claudeSettings.ts",
      "sidecar/src/chat/toolReview.ts",
      "sidecar/src/telegram/otpGate.ts",
      "sidecar/src/mcp/oauth.ts",
      "sidecar/src/agents/definitions/planner.md",
      "extension/background.js",
      "scripts/browser/host.ts",
    ]) {
      expect(classify([file(path)]).tier).toBe("high");
    }
  });

  it("counts an agent definition's lines toward size, though it is markdown", () => {
    // Already high by path; this checks the lines are counted, via the reason.
    const result = classify([file("sidecar/src/agents/definitions/planner.md", 900)]);
    expect(result.reasons).toContain("900 changed lines of code");
  });
});
