import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { passThrough } from "./passThrough";

class Thing {}
const real = { add: (a: number, b: number) => a + b, Thing, LIMIT: 3 };
const stand = passThrough(real);
afterEach(stand.reset);

describe("passThrough", () => {
  it("calls the real function until a test overrides it, and again after reset", () => {
    expect(stand.module.add(1, 2)).toBe(3);
    stand.stub({ add: () => 10 });
    expect(stand.module.add(1, 2)).toBe(10);
    stand.reset();
    expect(stand.module.add(1, 2)).toBe(3);
  });

  it("adds a later override to the ones already set", () => {
    stand.stub({ add: () => 10 });
    stand.stub({ Thing: class Other {} });
    expect(stand.module.add(1, 2)).toBe(10);
  });

  it("leaves classes and values as they are", () => {
    expect(stand.module.Thing).toBe(Thing);
    expect(new stand.module.Thing()).toBeInstanceOf(Thing);
    expect(stand.module.LIMIT).toBe(3);
  });
});

// A suite with its own `mock.module` of one of these replaces the shared
// registration for every file after it, and one that never resets leaks its
// overrides into them. Both fail only under some file orders, so they are
// checked here.
const SHARED: { module: string; helper: string; stub?: RegExp; reset?: string }[] = [
  { module: "lib/pr/api", helper: "prApi.ts", stub: /stubPrApi\(/, reset: "resetPrApi" },
  {
    module: "lib/workspaces",
    helper: "workspacesApi.ts",
    stub: /stubWorkspacesApi\(/,
    reset: "resetWorkspacesApi",
  },
  { module: "lib/pty", helper: "ptyApi.ts", stub: /stubPtyApi\(/, reset: "resetPtyApi" },
  { module: "lib/repos", helper: "reposApi.ts", stub: /stubReposApi\(/, reset: "resetReposApi" },
  {
    module: "lib/alarms",
    helper: "alarmFixture.ts",
    stub: /stubAlarmsApi\(/,
    reset: "resetAlarms",
  },
  {
    module: "lib/pr/cache",
    helper: "prFiles.ts",
    stub: /stubPrFiles\(|stubPrCache\(|setPrFiles\(|setPrFileContent\(/,
    reset: "resetPrCache",
  },
  // Stubbed only through `stubPrFiles`, so `resetPrCache` above clears it.
  { module: "lib/pr/insights", helper: "prFiles.ts" },
];

describe("suites stubbing a shared module", () => {
  const srcDir = resolve(import.meta.dir, "..");
  const sources = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(srcDir)].map((file) => {
    const path = join(srcDir, file);
    return { path, source: readFileSync(path, "utf8") };
  });
  const mocked = (path: string, source: string) =>
    [...source.matchAll(/mock\.module\(\s*["'](\.[^"']*)["']/g)].map(([, specifier]) =>
      resolve(dirname(path), specifier as string).replace(/\.tsx?$/, ""),
    );

  for (const shared of SHARED) {
    it(`go through ${shared.helper} for ${shared.module}`, () => {
      const target = join(srcDir, shared.module);
      const helper = join(srcDir, "test", shared.helper);
      const offenders = sources
        .filter(({ path, source }) => path !== helper && mocked(path, source).includes(target))
        .map(({ path }) => path);
      expect(offenders).toEqual([]);
    });

    const { stub, reset } = shared;
    if (stub && reset) {
      // Importing the reset isn't enough: it has to be handed to a hook or called.
      const resetRuns = new RegExp(`after(All|Each)\\(\\s*${reset}\\b|\\b${reset}\\(\\)`);
      it(`clear their ${shared.module} overrides`, () => {
        const leaking = sources
          .filter(({ path }) => path !== join(srcDir, "test", shared.helper))
          .filter(({ source }) => stub.test(source) && !resetRuns.test(source))
          .map(({ path }) => path);
        expect(leaking).toEqual([]);
      });
    }
  }
});
