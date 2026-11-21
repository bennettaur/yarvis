import { describe, expect, it } from "bun:test";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyCatalog, openCodeCatalog } from "./opencodeCatalog.ts";
import { makeTempDir } from "./testSupport.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fetch that answers `body` and counts its calls. */
function fakeFetch(body: string, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("the OpenCode model catalog", () => {
  it("downloads it when there is none, and uses the copy for a day", async () => {
    const path = join(makeTempDir("yarvis-catalog-"), "cache", "models.json");
    const { calls, fetchImpl } = fakeFetch('{"opencode": {}}');
    expect(await openCodeCatalog(fetchImpl, path)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe('{"opencode": {}}');
    expect(await openCodeCatalog(fetchImpl, path)).toBe(path);
    expect(calls).toEqual(["https://models.dev/api.json"]);
  });

  it("downloads it again once it is a day old, and keeps the old one when that fails", async () => {
    const path = join(makeTempDir("yarvis-catalog-"), "models.json");
    writeFileSync(path, '{"old": {}}');
    const old = (Date.now() - 2 * DAY_MS) / 1000;
    utimesSync(path, old, old);
    const { calls, fetchImpl } = fakeFetch("nope", 503);
    expect(await openCodeCatalog(fetchImpl, path)).toBe(path);
    expect(calls).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe('{"old": {}}');
  });

  it("answers null with no catalog at all, and refuses a download that isn't a JSON object", async () => {
    const path = join(makeTempDir("yarvis-catalog-"), "models.json");
    expect(await openCodeCatalog(fakeFetch("[1, 2]").fetchImpl, path)).toBeNull();
    expect(await openCodeCatalog(fakeFetch("<html>").fetchImpl, path)).toBeNull();
  });

  it("copies it into a process's folder, or answers null without one", () => {
    const folder = makeTempDir("yarvis-catalog-copy-");
    const source = join(folder, "source.json");
    writeFileSync(source, "{}");
    expect(copyCatalog(source, folder)).toBe(join(folder, "models.json"));
    expect(copyCatalog(null, folder)).toBeNull();
    expect(copyCatalog(join(folder, "missing.json"), folder)).toBeNull();
  });
});
