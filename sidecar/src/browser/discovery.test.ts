import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscovery } from "./discovery.ts";

let dir: string | undefined;

afterEach(async () => {
  delete process.env.YARVIS_BROWSER_DISCOVERY_PATH;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("writeDiscovery", () => {
  it("stores the port and token where only the user can read them", async () => {
    dir = await mkdtemp(join(tmpdir(), "yarvis-discovery-"));
    const path = join(dir, "nested", "browser.json");
    process.env.YARVIS_BROWSER_DISCOVERY_PATH = path;

    await writeDiscovery(4321, "tok");

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ port: 4321, token: "tok" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("tightens a file left readable by an earlier version", async () => {
    dir = await mkdtemp(join(tmpdir(), "yarvis-discovery-"));
    const path = join(dir, "browser.json");
    process.env.YARVIS_BROWSER_DISCOVERY_PATH = path;
    await writeFile(path, "{}");
    await chmod(path, 0o644);

    await writeDiscovery(1, "t");

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
