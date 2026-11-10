import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { areaOf, fileReader, importsOf, measureReach } from "./reach.ts";

describe("areaOf", () => {
  it("groups the sidecar by its first folder and the frontend by its first two", () => {
    expect(areaOf("sidecar/src/chat/agent.ts")).toBe("sidecar/src/chat");
    expect(areaOf("src/components/review/tabs/View.tsx")).toBe("src/components/review");
    expect(areaOf("src/App.tsx")).toBe("src/");
    expect(areaOf("scripts/verify/report.ts")).toBe("scripts/verify");
    expect(areaOf("demo/flows/a.ts")).toBe("demo/flows");
    expect(areaOf("video/src/Scene.tsx")).toBe("video/src");
    expect(areaOf("src-tauri/src/pty.rs")).toBeNull();
  });
});

describe("importsOf", () => {
  it("finds an import quickly however much space follows the keyword", () => {
    const text = `import${" ".repeat(200_000)}x\n`.repeat(3);
    const started = performance.now();
    importsOf("src/a.ts", text, new Set());
    expect(performance.now() - started).toBeLessThan(1000);
  });

  const files = new Set(["src/lib/api.ts", "src/lib/pr/index.ts", "src/components/A.tsx"]);

  it("resolves relative imports with and without extensions, and folder indexes", () => {
    const text = [
      'import { api } from "../lib/api";',
      'import type { Pr } from "../lib/pr";',
      'const lazy = import("./A.tsx");',
      'import { z } from "zod";',
      'import "./missing";',
    ].join("\n");
    expect(importsOf("src/components/B.tsx", text, files).sort()).toEqual([
      "src/components/A.tsx",
      "src/lib/api.ts",
      "src/lib/pr/index.ts",
    ]);
  });
});

describe("measureReach", () => {
  const imports = (...targets: string[]) => targets.map((t) => `import "${t}";`).join("\n");

  it("counts importers and the other areas they sit in, ignoring tests", () => {
    const sources: Record<string, string> = {
      "sidecar/src/lib/util.ts": "",
      "sidecar/src/lib/other.ts": imports("./util.ts"),
      "sidecar/src/chat/a.ts": imports("../lib/util.ts"),
      "sidecar/src/jobs/b.ts": imports("../lib/util.ts"),
      "sidecar/src/lib/util.test.ts": imports("./util.ts"),
      "sidecar/src/chat/lonely.ts": "",
    };
    const reach = measureReach(
      ["sidecar/src/lib/util.ts", "sidecar/src/chat/lonely.ts", "sidecar/src/lib/util.test.ts"],
      Object.keys(sources),
      (path) => sources[path] ?? null,
    );
    expect(reach).toEqual([
      { path: "sidecar/src/lib/util.ts", importers: 3, otherAreas: 2, suggested: "shared" },
      { path: "sidecar/src/chat/lonely.ts", importers: 0, otherAreas: 0, suggested: "leaf" },
    ]);
  });

  it("suggests local up to one other area and shared up to four", () => {
    const suggestedWith = (areas: string[]) => {
      const sources: Record<string, string> = { "sidecar/src/db/client.ts": "" };
      for (const area of areas) sources[`sidecar/src/${area}/x.ts`] = imports("../db/client.ts");
      return measureReach(["sidecar/src/db/client.ts"], Object.keys(sources), (p) =>
        p in sources ? sources[p] : null,
      )[0].suggested;
    };
    expect(suggestedWith(["db"])).toBe("local");
    expect(suggestedWith(["a"])).toBe("local");
    expect(suggestedWith(["a", "b", "c", "d"])).toBe("shared");
  });

  it("counts only TypeScript sources, as changed files and as importers", () => {
    const sources: Record<string, string> = {
      "sidecar/src/lib/util.ts": "",
      "sidecar/src/chat/notes.md": imports("../lib/util.ts"),
      "docs/x.md": "",
    };
    const reach = measureReach(
      ["sidecar/src/lib/util.ts", "docs/x.md", "src-tauri/src/a.rs"],
      Object.keys(sources),
      (path) => sources[path] ?? null,
    );
    expect(reach).toEqual([
      { path: "sidecar/src/lib/util.ts", importers: 0, otherAreas: 0, suggested: "leaf" },
    ]);
  });

  it("leaves out changed files that no longer exist", () => {
    expect(measureReach(["sidecar/src/gone.ts"], [], () => null)).toEqual([]);
  });

  it("suggests core for a file imported from five other areas", () => {
    const areas = ["a", "b", "c", "d", "e"];
    const sources: Record<string, string> = { "sidecar/src/db/client.ts": "" };
    for (const area of areas) sources[`sidecar/src/${area}/x.ts`] = imports("../db/client.ts");
    const [reach] = measureReach(["sidecar/src/db/client.ts"], Object.keys(sources), (p) =>
      p in sources ? sources[p] : null,
    );
    expect(reach.suggested).toBe("core");
  });
});

describe("fileReader", () => {
  it("reads a file under the root, and gives null for one that is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "reach-"));
    writeFileSync(join(root, "a.ts"), "export {};");
    const read = fileReader(root);
    expect(read("a.ts")).toBe("export {};");
    expect(read("missing.ts")).toBeNull();
  });

  it("refuses a symlink, a FIFO and an oversized file", () => {
    const root = mkdtempSync(join(tmpdir(), "reach-"));
    writeFileSync(join(root, "real.ts"), "export {};");
    symlinkSync(join(root, "real.ts"), join(root, "link.ts"));
    execFileSync("mkfifo", [join(root, "fifo.ts")]);
    writeFileSync(join(root, "big.ts"), "x".repeat(1_000_001));
    const read = fileReader(root);
    expect(read("link.ts")).toBeNull();
    expect(read("fifo.ts")).toBeNull();
    expect(read("big.ts")).toBeNull();
  });

  it("refuses a file reached through a symlinked folder outside the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "reach-out-"));
    writeFileSync(join(outside, "secret.ts"), "export {};");
    const root = mkdtempSync(join(tmpdir(), "reach-"));
    symlinkSync(outside, join(root, "linked"));
    expect(fileReader(root)("linked/secret.ts")).toBeNull();
  });
});
