import { describe, expect, it } from "bun:test";
import {
  importSpecifiers,
  isTsJsPath,
  loadTsPathConfig,
  MAX_SPECIFIERS,
  parseJsonc,
  resolveSpecifier,
  type TsPathConfig,
} from "./imports";

/** A head tree held in memory: every path, and the text of the ones read. */
function repo(files: Record<string, string>) {
  const tree = new Set(Object.keys(files));
  const readFile = async (path: string) => files[path] ?? null;
  return { tree, readFile };
}

const resolve = (
  files: Record<string, string>,
  spec: string,
  from: string,
  config: TsPathConfig | null = null,
) => resolveSpecifier(spec, from, new Set(Object.keys(files)), config);

describe("importSpecifiers", () => {
  it("reads every way a file names a module", () => {
    const source = [
      'import a from "./a";',
      "import { b, c } from '../b';",
      'import type { T } from "@/types";',
      'import "./side-effect.css";',
      'export * from "./re";',
      'export { x } from "pkg/sub";',
      "const lazy = import('./lazy');",
      'const old = require("./old");',
      '/// <reference path="./globals.d.ts" />',
      // Prettier wraps a long import over several lines.
      "import {\n  multi,\n  line,\n} from './multi';",
    ].join("\n");
    expect(importSpecifiers(source).sort()).toEqual(
      [
        "../b",
        "./a",
        "./globals.d.ts",
        "./lazy",
        "./multi",
        "./old",
        "./re",
        "./side-effect.css",
        "@/types",
        "pkg/sub",
      ].sort(),
    );
  });

  it("stops at the specifier cap", () => {
    const source = Array.from({ length: MAX_SPECIFIERS + 50 }, (_, i) => `import "./m${i}";`).join(
      "\n",
    );
    expect(importSpecifiers(source)).toHaveLength(MAX_SPECIFIERS);
  });

  it("reads hostile files in well under a second", () => {
    for (const content of [
      "\n".repeat(2_000_000),
      "import ".repeat(45_000),
      `import${" ".repeat(500_000)}`,
      `from '${"x".repeat(500_000)}`,
      `export {${" a,".repeat(100_000)}`,
    ]) {
      const started = performance.now();
      importSpecifiers(content);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

describe("isTsJsPath", () => {
  it("knows the TypeScript worker's files", () => {
    for (const yes of ["a.ts", "b.tsx", "c.d.ts", "d.js", "e.jsx", "f.mjs", "g.cts"]) {
      expect(isTsJsPath(yes)).toBe(true);
    }
    for (const no of ["a.py", "b.json", "tsconfig", "c.ts.snap"])
      expect(isTsJsPath(no)).toBe(false);
  });
});

describe("resolveSpecifier", () => {
  it("resolves relative imports with extensions, index files and ESM .js names", () => {
    const files = {
      "src/a.ts": "",
      "src/b.tsx": "",
      "src/util/index.ts": "",
      "src/legacy.js": "",
      "src/esm.ts": "",
      "lib/types.d.ts": "",
      "app/(group)/page.tsx": "",
    };
    expect(resolve(files, "./b", "src/a.ts")).toBe("src/b.tsx");
    expect(resolve(files, "./util", "src/a.ts")).toBe("src/util/index.ts");
    expect(resolve(files, "./legacy", "src/a.ts")).toBe("src/legacy.js");
    expect(resolve(files, "./esm.js", "src/a.ts")).toBe("src/esm.ts");
    expect(resolve(files, "../lib/types", "src/a.ts")).toBe("lib/types.d.ts");
    expect(resolve(files, "./util/index.ts", "src/a.ts")).toBe("src/util/index.ts");
    expect(resolve(files, "../app/(group)/page", "src/a.ts")).toBe("app/(group)/page.tsx");
  });

  it("answers null for a missing file, a climb out of the repo, a URL or a package", () => {
    const files = { "src/a.ts": "", "node_modules/react/index.d.ts": "" };
    expect(resolve(files, "./missing", "src/a.ts")).toBeNull();
    expect(resolve(files, "../../outside", "src/a.ts")).toBeNull();
    expect(resolve(files, "https://example.com/x.js", "src/a.ts")).toBeNull();
    expect(resolve(files, "/abs/x", "src/a.ts")).toBeNull();
    // A committed package's types aren't loaded: their ambient declarations
    // would reach every PR sharing the worker.
    expect(resolve(files, "react", "src/a.ts", { dir: "", paths: {} })).toBeNull();
  });

  it("follows paths, the longest prefix first and each target in turn, then baseUrl", () => {
    const files = {
      "src/components/Button.tsx": "",
      "src/lib/x.ts": "",
      "generated/lib/y.ts": "",
      "src/exact.ts": "",
      "src/fromBase.ts": "",
    };
    const config: TsPathConfig = {
      dir: "",
      baseUrl: "src",
      paths: {
        "@/*": ["src/*"],
        "@/lib/*": ["src/lib/*", "generated/lib/*"],
        "~exact": ["src/exact.ts"],
      },
    };
    expect(resolve(files, "@/components/Button", "src/a.ts", config)).toBe(
      "src/components/Button.tsx",
    );
    expect(resolve(files, "@/lib/x", "src/a.ts", config)).toBe("src/lib/x.ts");
    expect(resolve(files, "@/lib/y", "src/a.ts", config)).toBe("generated/lib/y.ts");
    expect(resolve(files, "~exact", "src/a.ts", config)).toBe("src/exact.ts");
    expect(resolve(files, "fromBase", "src/a.ts", config)).toBe("src/fromBase.ts");
  });
});

describe("parseJsonc", () => {
  it("takes comments and trailing commas, and keeps // inside strings", () => {
    expect(
      parseJsonc(
        '{\n  // a comment\n  "url": "https://x.dev/*", /* block */\n  "list": [1, 2,],\n}',
      ),
    ).toEqual({ url: "https://x.dev/*", list: [1, 2] });
    expect(parseJsonc("{ nope")).toBeNull();
  });
});

describe("loadTsPathConfig", () => {
  it("finds the nearest config and makes paths repo-relative", async () => {
    const { tree, readFile } = repo({
      "tsconfig.json": '{ "compilerOptions": { "paths": { "@root/*": ["./x/*"] } } }',
      "packages/web/tsconfig.json":
        '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
      "packages/web/src/a.ts": "",
    });
    expect(await loadTsPathConfig("packages/web/src/a.ts", tree, readFile)).toEqual({
      dir: "packages/web",
      baseUrl: "packages/web",
      paths: { "@/*": ["packages/web/src/*"] },
    });
    expect(await loadTsPathConfig("other/b.ts", tree, readFile)).toEqual({
      dir: "",
      paths: { "@root/*": ["x/*"] },
    });
  });

  it("applies a relative extends and follows a solution config's references", async () => {
    const { tree, readFile } = repo({
      "tsconfig.base.json":
        '{ "compilerOptions": { "baseUrl": "./", "paths": { "@/*": ["src/*"] } } }',
      "app/tsconfig.json": '{ "extends": "../tsconfig.base.json" }',
      "tsconfig.json": '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
      "tsconfig.app.json": '{ "compilerOptions": { "paths": { "~/*": ["./web/*"] } } }',
    });
    expect(await loadTsPathConfig("app/x.ts", tree, readFile)).toEqual({
      dir: "app",
      baseUrl: "",
      paths: { "@/*": ["src/*"] },
    });
    expect(await loadTsPathConfig("web/y.ts", tree, readFile)).toEqual({
      dir: "",
      paths: { "~/*": ["web/*"] },
    });
  });

  it("answers null without a config, and survives one that isn't JSON", async () => {
    const none = repo({ "a.ts": "" });
    expect(await loadTsPathConfig("a.ts", none.tree, none.readFile)).toBeNull();
    const broken = repo({ "tsconfig.json": "{ not json" });
    expect(await loadTsPathConfig("a.ts", broken.tree, broken.readFile)).toBeNull();
  });
});
