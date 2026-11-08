import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fetchPrDetail } from "../lib/pr/api";
import type { PrDetail } from "../lib/pr/types";
import { resetPrApi, stubPrApi } from "./prApi";

afterEach(resetPrApi);

describe("stubPrApi", () => {
  it("answers with the override until it is reset", async () => {
    const stubbed = { number: 1 } as PrDetail;
    stubPrApi({ fetchPrDetail: async () => stubbed });
    const ref = { provider: "github", owner: "o", repo: "r", number: 1 } as const;
    expect(await fetchPrDetail(ref)).toBe(stubbed);

    resetPrApi();
    stubPrApi({ fetchPrDetail: async () => ({ number: 2 }) as PrDetail });
    expect((await fetchPrDetail(ref)).number).toBe(2);
  });
});

// A suite with its own `mock.module` of `lib/pr/api` replaces this stub for
// every file after it, and one that never resets leaks its overrides into
// them. Both fail only under some file orders, so they are checked here.
describe("suites stubbing lib/pr/api", () => {
  const srcDir = resolve(import.meta.dir, "..");
  const apiPath = join(srcDir, "lib", "pr", "api");
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(srcDir)]
    .map((file) => join(srcDir, file))
    .filter((file) => file !== join(srcDir, "test", "prApi.ts"));

  it("go through the shared stub rather than their own mock.module", () => {
    const offenders = files.filter((file) =>
      [...readFileSync(file, "utf8").matchAll(/mock\.module\(\s*["'](\.[^"']*)["']/g)].some(
        ([, specifier]) => resolve(dirname(file), specifier).replace(/\.tsx?$/, "") === apiPath,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("clear their overrides", () => {
    const leaking = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes("stubPrApi(") && !source.includes("resetPrApi");
    });
    expect(leaking).toEqual([]);
  });
});
