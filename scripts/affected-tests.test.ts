import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fullRunTrigger, SUITES } from "./affected-tests.ts";

const ROOT = join(import.meta.dir, "..");

describe("SUITES", () => {
  it("hands bun test the same paths as the full frontend run", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBe(`bun test ${SUITES.frontend.roots.join(" ")}`);
  });

  it("names always-run test files that exist", () => {
    for (const suite of Object.values(SUITES)) {
      for (const file of suite.alwaysRun) {
        expect(existsSync(join(ROOT, suite.cwd, file))).toBe(true);
      }
    }
  });

  it("runs both suites in full when the selection itself changes", () => {
    for (const suite of Object.values(SUITES)) {
      expect(fullRunTrigger(suite, ["scripts/affected-tests.ts"])).toBe(
        "scripts/affected-tests.ts",
      );
    }
  });
});

describe("fullRunTrigger", () => {
  it("leaves an ordinary source change to bun's import tracing", () => {
    expect(fullRunTrigger(SUITES.sidecar, ["sidecar/src/chat/agent.ts", "docs/x.md"])).toBeNull();
  });

  it("runs everything when the lockfile changes", () => {
    expect(fullRunTrigger(SUITES.frontend, ["src/App.tsx", "bun.lock"])).toBe("bun.lock");
  });

  it("matches a folder entry against anything inside it", () => {
    expect(fullRunTrigger(SUITES.sidecar, ["sidecar/drizzle/0063_x.sql"])).toBe(
      "sidecar/drizzle/0063_x.sql",
    );
  });

  it("matches a folder entry only inside that folder", () => {
    expect(fullRunTrigger(SUITES.frontend, ["src/testing/x.ts", "src/test-utils.ts"])).toBeNull();
  });

  it("matches a file entry exactly, not as a prefix", () => {
    expect(fullRunTrigger(SUITES.frontend, ["tsconfig.json.bak"])).toBeNull();
  });

  it("runs the frontend suite in full for the sidecar preload it also loads", () => {
    expect(fullRunTrigger(SUITES.frontend, ["sidecar/src/test/setup.ts"])).toBe(
      "sidecar/src/test/setup.ts",
    );
  });

  it("keeps the sidecar's migrations from forcing a full frontend run", () => {
    expect(fullRunTrigger(SUITES.frontend, ["sidecar/drizzle/0063_x.sql"])).toBeNull();
  });
});
