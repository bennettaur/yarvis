import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCustomProvider,
  deleteCustomProvider,
  getCustomProvider,
  listCustomProviders,
  updateCustomProvider,
} from "./service.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-custom-providers-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

const input = {
  name: "litellm",
  baseUrl: "https://litellm.example.com/v1",
  apiKind: "openai" as const,
  models: ["gpt-4o"],
  headerNames: ["X-Tenant"],
};

describe("customProviders/service", () => {
  it("lists an empty array initially", async () => {
    expect(await listCustomProviders()).toEqual([]);
  });

  it("lists providers sorted by name", async () => {
    await createCustomProvider({ ...input, name: "zeta" });
    await createCustomProvider({ ...input, name: "alpha" });
    await createCustomProvider({ ...input, name: "mike" });
    const names = (await listCustomProviders()).map((r) => r.name);
    expect(names).toEqual(["alpha", "mike", "zeta"]);
  });

  it("creates a provider with a generated id and timestamps", async () => {
    const row = await createCustomProvider(input);
    expect(row.id).toBeTruthy();
    expect(row.name).toBe("litellm");
    expect(row.createdAt).toBe(row.updatedAt);
    expect(new Date(row.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("gets a provider by id", async () => {
    const row = await createCustomProvider(input);
    expect(await getCustomProvider(row.id)).toEqual(row);
  });

  it("returns null getting an unknown id", async () => {
    expect(await getCustomProvider("does-not-exist")).toBeNull();
  });

  it("updates merges the patch and bumps updatedAt", async () => {
    const row = await createCustomProvider(input);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = await updateCustomProvider(row.id, { models: ["gpt-4o-mini"] });
    expect(updated).not.toBeNull();
    expect(updated?.models).toEqual(["gpt-4o-mini"]);
    expect(updated?.name).toBe(row.name);
    expect(updated?.createdAt).toBe(row.createdAt);
    expect(updated?.updatedAt).not.toBe(row.createdAt);
  });

  it("returns null updating an unknown id", async () => {
    expect(await updateCustomProvider("does-not-exist", { name: "x" })).toBeNull();
  });

  it("deletes a provider, returning true, then false for the same id", async () => {
    const row = await createCustomProvider(input);
    expect(await deleteCustomProvider(row.id)).toBe(true);
    expect(await deleteCustomProvider(row.id)).toBe(false);
    expect(await getCustomProvider(row.id)).toBeNull();
  });
});
