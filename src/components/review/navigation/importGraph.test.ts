import { describe, expect, it } from "bun:test";
import {
  DEFAULT_IMPORT_BUDGET,
  type ImportBudget,
  ImportCollector,
  mapLimit,
  READ_CONCURRENCY,
} from "./importGraph";

function collector(files: Record<string, string>, budget: Partial<ImportBudget> = {}) {
  const reads: string[] = [];
  const source = {
    tree: new Set(Object.keys(files)),
    readFile: async (path: string) => {
      reads.push(path);
      return files[path] ?? null;
    },
  };
  return { collector: new ImportCollector(source, { ...DEFAULT_IMPORT_BUDGET, ...budget }), reads };
}

/** A chain a → b → c → d → e, each importing the next. */
const chain: Record<string, string> = {
  "src/a.ts": 'import { b } from "./b";',
  "src/b.ts": 'import { c } from "./c";',
  "src/c.ts": 'import { d } from "./d";',
  "src/d.ts": 'import { e } from "./e";',
  "src/e.ts": "export const e = 1;",
};

describe("ImportCollector", () => {
  it("follows imports to the depth budget, breadth first", async () => {
    const { collector: c } = collector(chain, { maxDepth: 2 });
    const found = await c.collect({ path: "src/a.ts", content: chain["src/a.ts"] as string });
    expect(found.files.map((f) => f.path)).toEqual(["src/b.ts", "src/c.ts"]);
    expect(found.exhausted).toBe(false);
  });

  it("loads each file once across the files a PR opens", async () => {
    const { collector: c, reads } = collector(chain, { maxDepth: 2 });
    await c.collect({ path: "src/a.ts", content: chain["src/a.ts"] as string });
    const second = await c.collect({ path: "src/b.ts", content: chain["src/b.ts"] as string });
    // b's own imports were loaded the first time; only what is new comes back.
    expect(second.files.map((f) => f.path)).toEqual(["src/d.ts"]);
    expect(reads.filter((p) => p === "src/c.ts")).toHaveLength(1);
  });

  it("stops at the file budget and says so", async () => {
    const files = {
      "a.ts": 'import "./b"; import "./c"; import "./d";',
      "b.ts": "",
      "c.ts": "",
      "d.ts": "",
    };
    const { collector: c } = collector(files, { maxFiles: 2 });
    const found = await c.collect({ path: "a.ts", content: files["a.ts"] });
    expect(found.files.map((f) => f.path)).toEqual(["b.ts", "c.ts"]);
    expect(found.exhausted).toBe(true);
  });

  it("skips a file over the per-file size and stops at the byte budget", async () => {
    const files = {
      "a.ts": 'import "./big"; import "./b"; import "./c";',
      "big.ts": "x".repeat(100),
      "b.ts": "y".repeat(30),
      "c.ts": "z".repeat(30),
    };
    const { collector: c } = collector(files, { maxFileBytes: 50, maxBytes: 40 });
    const found = await c.collect({ path: "a.ts", content: files["a.ts"] });
    expect(found.files.map((f) => f.path)).toEqual(["b.ts"]);
    expect(found.exhausted).toBe(true);
  });

  it("ignores imports that resolve nowhere, and reports what bare specifiers resolved to", async () => {
    const files = {
      "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      "src/a.ts": 'import x from "@/lib/x"; import "./missing"; import React from "react";',
      "src/lib/x.ts": "export default 1;",
    };
    const { collector: c } = collector(files);
    const found = await c.collect({ path: "src/a.ts", content: files["src/a.ts"] });
    expect(found.files.map((f) => f.path)).toEqual(["src/lib/x.ts"]);
    expect(found.shims).toEqual([
      {
        path: "node_modules/@/lib/x.ts",
        target: "src/lib/x.ts",
        content: expect.stringContaining('export * from "../../../src/lib/x"'),
      },
    ]);
  });

  it("follows a Prettier-wrapped import", async () => {
    const files = {
      "a.ts": "import {\n  one,\n  two,\n} from './b';\n",
      "b.ts": "export const one = 1, two = 2;",
    };
    const { collector: c } = collector(files);
    const found = await c.collect({ path: "a.ts", content: files["a.ts"] });
    expect(found.files.map((f) => f.path)).toEqual(["b.ts"]);
  });

  it("reads a wide import list a few files at a time", async () => {
    const files: Record<string, string> = {
      "a.ts": Array.from({ length: 40 }, (_, i) => `import "./m${i}";`).join("\n"),
    };
    for (let i = 0; i < 40; i++) files[`m${i}.ts`] = "";
    let inFlight = 0;
    let most = 0;
    const source = {
      tree: new Set(Object.keys(files)),
      readFile: async (path: string) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await Bun.sleep(1);
        inFlight--;
        return files[path] ?? null;
      },
    };
    const found = await new ImportCollector(source).collect({
      path: "a.ts",
      content: files["a.ts"] as string,
    });
    expect(found.files).toHaveLength(40);
    expect(most).toBeLessThanOrEqual(READ_CONCURRENCY);
  });
});

describe("mapLimit", () => {
  it("keeps results in order", async () => {
    expect(await mapLimit([3, 1, 2], 2, async (n) => n * 10)).toEqual([30, 10, 20]);
  });
});
