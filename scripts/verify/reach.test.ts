import { describe, expect, it } from "bun:test";
import { areaOf, importsOf, measureReach } from "./reach.ts";

describe("areaOf", () => {
  it("groups the sidecar by its first folder and the frontend by its first two", () => {
    expect(areaOf("sidecar/src/chat/agent.ts")).toBe("sidecar/src/chat");
    expect(areaOf("src/components/review/tabs/View.tsx")).toBe("src/components/review");
    expect(areaOf("src/App.tsx")).toBe("src/");
    expect(areaOf("src-tauri/src/pty.rs")).toBeNull();
  });
});

describe("importsOf", () => {
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
