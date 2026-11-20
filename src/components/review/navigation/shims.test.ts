import { describe, expect, it } from "bun:test";
import { aliasShim } from "./shims";

const tree = new Set(["src/lib/x.ts", "app/(group)/lib/c.tsx", "node_modules/@/taken.ts"]);

describe("aliasShim", () => {
  it("puts a re-export under the config's node_modules, relative to the target", () => {
    expect(aliasShim("@/lib/x", "src/lib/x.ts", "", tree)).toEqual({
      path: "node_modules/@/lib/x.ts",
      target: "src/lib/x.ts",
      content:
        'export * from "../../../src/lib/x";\nexport { default } from "../../../src/lib/x";\n',
    });
  });

  it("scopes a nested config's aliases to its own folder, and keeps (group) folders", () => {
    expect(aliasShim("~/c", "app/(group)/lib/c.tsx", "app", tree)).toMatchObject({
      path: "app/node_modules/~/c.ts",
      content: expect.stringContaining('from "../../(group)/lib/c"'),
    });
  });

  it("names the stand-in without the extension an ESM import carries", () => {
    expect(aliasShim("@/lib/x.js", "src/lib/x.ts", "", tree)?.path).toBe("node_modules/@/lib/x.ts");
  });

  it("refuses a specifier that can't safely name a file, or would cover a real one", () => {
    for (const bad of ["@/../x", "@/./x", "@/x*", "@/a b", "@/%2e%2e", "@//x", "@/x?y"]) {
      expect({ bad, shim: aliasShim(bad, "src/lib/x.ts", "", tree) }).toEqual({ bad, shim: null });
    }
    expect(aliasShim("@/taken", "src/lib/x.ts", "", tree)).toBeNull();
  });
});
