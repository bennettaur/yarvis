import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSection, settingsPath, withSection } from "./store.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-settings-store-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe("settings/store", () => {
  it("resolves the override path", () => {
    expect(settingsPath()).toBe(join(dir, "settings.json"));
  });

  it("reads an absent section as undefined", async () => {
    expect(await readSection("customProviders")).toBeUndefined();
  });

  it("writes a section and reads it back", async () => {
    await withSection<{ a: number }, void>("widgets", () => ({
      next: { a: 1 },
      result: undefined,
    }));
    expect(await readSection<{ a: number }>("widgets")).toEqual({ a: 1 });
  });

  it("hands the current value to the mutator", async () => {
    await withSection<{ a: number }, void>("widgets", () => ({
      next: { a: 1 },
      result: undefined,
    }));
    await withSection<{ a: number }, void>("widgets", (current) => ({
      next: { a: (current?.a ?? 0) + 1 },
      result: undefined,
    }));
    expect(await readSection<{ a: number }>("widgets")).toEqual({ a: 2 });
  });

  it("returns the mutator's result", async () => {
    const result = await withSection<{ a: number }, string>("widgets", () => ({
      next: { a: 1 },
      result: "saved",
    }));
    expect(result).toBe("saved");
  });

  it("never touches another section", async () => {
    await withSection<{ a: number }, void>("alpha", () => ({ next: { a: 1 }, result: undefined }));
    await withSection<{ b: number }, void>("beta", () => ({ next: { b: 2 }, result: undefined }));
    expect(await readSection<{ a: number }>("alpha")).toEqual({ a: 1 });
    expect(await readSection<{ b: number }>("beta")).toEqual({ b: 2 });
  });

  it("preserves keys it does not know about, e.g. the core's own settings", async () => {
    await withSection<{ a: number }, void>("alpha", () => ({ next: { a: 1 }, result: undefined }));
    const raw = JSON.parse(await readFile(settingsPath(), "utf8"));
    raw.maxPtySessions = 42;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(settingsPath(), JSON.stringify(raw));

    await withSection<{ a: number }, void>("alpha", (current) => ({
      next: { a: (current?.a ?? 0) + 1 },
      result: undefined,
    }));

    const final = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(final.maxPtySessions).toBe(42);
    expect(final.alpha).toEqual({ a: 2 });
  });

  it("serializes concurrent writes rather than losing one", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withSection<number[], void>("list", (current) => ({
          next: [...(current ?? []), i],
          result: undefined,
        })),
      ),
    );
    const list = await readSection<number[]>("list");
    expect(list).toHaveLength(20);
    expect(new Set(list)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => i)));
  });

  it("creates the directory and file with restrictive permissions", async () => {
    await withSection<{ a: number }, void>("alpha", () => ({ next: { a: 1 }, result: undefined }));
    const { stat } = await import("node:fs/promises");
    const fileMode = (await stat(settingsPath())).mode & 0o777;
    const dirMode = (await stat(dir)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("falls back to an empty document when the file holds malformed JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(settingsPath(), "not json");
    expect(await readSection("alpha")).toBeUndefined();
  });
});
