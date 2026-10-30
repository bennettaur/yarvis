import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureOk, SidecarError, sidecarFetch } from "../lib/api";
import { resetSidecarApi, stubSidecarApi } from "./sidecarApi";

afterEach(resetSidecarApi);

describe("stubSidecarApi", () => {
  it("passes a call through to the real client when nothing is stubbed", async () => {
    const failed = ensureOk(
      new Response(JSON.stringify({ error: "nope" }), { status: 409 }),
      "save",
    );
    await expect(failed).rejects.toBeInstanceOf(SidecarError);
    await expect(failed).rejects.toThrow("save failed (409): nope");
  });

  it("answers with the override until it is reset", async () => {
    stubSidecarApi({ sidecarFetch: async () => new Response("stubbed") });
    expect(await (await sidecarFetch("/anything")).text()).toBe("stubbed");

    resetSidecarApi();
    stubSidecarApi({ ensureOk: async () => {} });
    await expect(ensureOk(new Response(null, { status: 500 }), "x")).resolves.toBeUndefined();
  });
});

// A suite with its own `mock.module` of `lib/api` replaces this stub for every
// file after it, and one that never resets leaks its overrides into them. Both
// fail only under some file orders, so they are checked here instead.
describe("suites stubbing lib/api", () => {
  const srcDir = resolve(import.meta.dir, "..");
  const apiPath = join(srcDir, "lib", "api");
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(srcDir)]
    .map((file) => join(srcDir, file))
    .filter((file) => file !== join(srcDir, "test", "sidecarApi.ts"));

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
      return source.includes("stubSidecarApi(") && !source.includes("resetSidecarApi");
    });
    expect(leaking).toEqual([]);
  });
});
