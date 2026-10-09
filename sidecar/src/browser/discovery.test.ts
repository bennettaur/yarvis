import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceFileName, writeDiscovery } from "./discovery.ts";

let dir: string | undefined;

async function useTempDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "yarvis-discovery-"));
  const instances = join(dir, "nested", "instances");
  process.env.YARVIS_BROWSER_INSTANCES_DIR = instances;
  return instances;
}

afterEach(async () => {
  delete process.env.YARVIS_BROWSER_INSTANCES_DIR;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

// A live pid, so the sweep that runs on every write leaves these files alone.
const entry = { name: "main", port: 4321, token: "tok", pid: process.pid };

describe("writeDiscovery", () => {
  it("writes one file per instance where only the user can read it", async () => {
    const instances = await useTempDir();
    const path = await writeDiscovery(entry);
    await writeDiscovery({ ...entry, name: "my-branch", port: 5555 });
    const other = join(instances, `my-branch-${process.pid}.json`);

    expect(path).toBe(join(instances, `main-${process.pid}.json`));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(entry);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(other, "utf8")).port).toBe(5555);
  });

  it("tightens a file left readable by an earlier version", async () => {
    const instances = await useTempDir();
    await mkdir(instances, { recursive: true });
    const path = join(instances, `main-${process.pid}.json`);
    await writeFile(path, "{}");
    await chmod(path, 0o644);

    await writeDiscovery(entry);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("writeDiscovery sweep", () => {
  it("deletes the file of an instance whose process is gone", async () => {
    const instances = await useTempDir();
    await mkdir(instances, { recursive: true });
    // A pid this high is never handed out, so it stands in for a dead process.
    const stale = join(instances, "old-999999.json");
    await writeFile(stale, JSON.stringify({ ...entry, pid: 999_999 }));

    await writeDiscovery(entry);

    expect(await readFile(stale, "utf8").catch(() => null)).toBeNull();
  });
});

describe("instanceFileName", () => {
  it("slugs the name and keeps processes that share one apart", () => {
    expect(instanceFileName("migration-test", 7)).toBe("migration-test-7.json");
    expect(instanceFileName("My Branch/../x", 7)).toBe("my-branch-x-7.json");
    expect(instanceFileName("///", 7)).toBe("instance-7.json");
    expect(instanceFileName("main", 1)).not.toBe(instanceFileName("main", 2));
  });
});
