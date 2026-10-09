import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedByMe, parseInstance, readTrustedEntry } from "./instances.ts";

const TOKEN = "a".repeat(64);

describe("parseInstance", () => {
  it("accepts a complete entry", () => {
    const entry = { name: "main", port: 8765, token: TOKEN, pid: 42 };
    expect(parseInstance(entry)).toEqual(entry);
  });

  it("refuses an entry with a bad port, pid or missing field", () => {
    expect(parseInstance({ name: "a", port: 0, token: TOKEN, pid: 1 })).toBeNull();
    expect(parseInstance({ name: "a", port: 70000, token: TOKEN, pid: 1 })).toBeNull();
    expect(parseInstance({ name: "a", port: 1, token: TOKEN, pid: -1 })).toBeNull();
    expect(parseInstance({ port: 1, token: TOKEN, pid: 1 })).toBeNull();
    expect(parseInstance(null)).toBeNull();
  });
});

describe("parseInstance tokens and ports", () => {
  const entry = { name: "main", port: 8765, token: TOKEN, pid: 42 };

  it("refuses a token that isn't what a sidecar mints", () => {
    expect(parseInstance({ ...entry, token: "short" })).toBeNull();
    expect(parseInstance({ ...entry, token: `${TOKEN}\r\nX-Evil: 1` })).toBeNull();
    expect(parseInstance({ ...entry, token: "A".repeat(64) })).toBeNull();
  });

  it("refuses a privileged port", () => {
    expect(parseInstance({ ...entry, port: 80 })).toBeNull();
    expect(parseInstance({ ...entry, port: 1024 })).not.toBeNull();
  });
});

describe("ownedByMe", () => {
  it("trusts only this user's files that no one else can write", () => {
    expect(ownedByMe({ uid: 501, mode: 0o100600 }, 501)).toBe(true);
    expect(ownedByMe({ uid: 501, mode: 0o40700 }, 501)).toBe(true);
    expect(ownedByMe({ uid: 502, mode: 0o100600 }, 501)).toBe(false);
    expect(ownedByMe({ uid: 501, mode: 0o100620 }, 501)).toBe(false);
    expect(ownedByMe({ uid: 501, mode: 0o100602 }, 501)).toBe(false);
  });
});

describe("readTrustedEntry", () => {
  let dir: string | undefined;
  const me = process.getuid?.() ?? -1;
  const entry = { name: "main", port: 8765, token: TOKEN, pid: 42 };

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function file(mode: number): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "yarvis-instances-"));
    const path = join(dir, "main-42.json");
    await writeFile(path, JSON.stringify(entry));
    await chmod(path, mode);
    return path;
  }

  it("reads a file only this user can write", async () => {
    expect(await readTrustedEntry(await file(0o600), me)).toEqual(entry);
  });

  it("ignores a file others can write", async () => {
    expect(await readTrustedEntry(await file(0o666), me)).toBeNull();
  });

  it("refuses a symlink in place of the file", async () => {
    const target = await file(0o600);
    const link = join(dir as string, "link.json");
    await symlink(target, link);
    await expect(readTrustedEntry(link, me)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("skips a FIFO named like an entry instead of waiting on it", async () => {
    dir = await mkdtemp(join(tmpdir(), "yarvis-instances-"));
    const fifo = join(dir, "main-1.json");
    Bun.spawnSync(["mkfifo", fifo]);
    expect(await readTrustedEntry(fifo, me)).toBeNull();
  });

  it("skips a file too big to be an entry", async () => {
    const path = await file(0o600);
    await writeFile(path, " ".repeat(5000));
    expect(await readTrustedEntry(path, me)).toBeNull();
  });
});
