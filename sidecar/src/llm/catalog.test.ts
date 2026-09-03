import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogFor,
  DEFAULT_MODELS,
  deleteProviderModel,
  isModelCapability,
  listProviderModels,
  type ModelInfo,
  type ProviderModelRow,
  resetProviderModels,
  saveProviderModel,
  withCapability,
} from "./catalog.ts";

function row(
  partial: Partial<Omit<ProviderModelRow, "capabilities">> & {
    providerId: string;
    modelId: string;
    // Loosened to `string[]` (rather than `ModelCapability[]`) so the
    // "unknown capability" test below can exercise `rowToInfo`'s filtering
    // of a tag this build doesn't recognize.
    capabilities?: string[];
  },
) {
  return {
    capabilities: ["chat"],
    enabled: true,
    sortOrder: 0,
    ...partial,
  } as ProviderModelRow;
}

describe("catalogFor", () => {
  it("falls back to the bundled defaults when a provider has no rows", () => {
    expect(catalogFor("gemini", [])).toEqual(DEFAULT_MODELS.gemini!);
  });

  it("replaces the defaults rather than merging with them", () => {
    const catalog = catalogFor("gemini", [row({ providerId: "gemini", modelId: "only-this" })]);
    expect(catalog).toEqual([{ id: "only-this", capabilities: ["chat"] }]);
  });

  it("ignores rows belonging to another provider", () => {
    expect(catalogFor("gemini", [row({ providerId: "anthropic", modelId: "x" })])).toEqual(
      DEFAULT_MODELS.gemini!,
    );
  });

  it("leaves out disabled rows", () => {
    const rows = [
      row({ providerId: "gemini", modelId: "on" }),
      row({ providerId: "gemini", modelId: "off", enabled: false }),
    ];
    expect(catalogFor("gemini", rows).map((m) => m.id)).toEqual(["on"]);
  });

  it("drops capability tags this build cannot act on", () => {
    const rows = [row({ providerId: "gemini", modelId: "m", capabilities: ["chat", "telepathy"] })];
    expect(catalogFor("gemini", rows)[0]?.capabilities).toEqual(["chat"]);
  });

  it("uses the given fallback for a provider with no bundled defaults", () => {
    const fallback: ModelInfo[] = [{ id: "gpt-4o", capabilities: ["chat"] }];
    expect(catalogFor("custom:abc", [], fallback)).toEqual(fallback);
  });
});

describe("withCapability", () => {
  it("keeps only the models that serve it", () => {
    const models: ModelInfo[] = [
      { id: "flash", capabilities: ["chat", "stt"] },
      { id: "flash-tts", capabilities: ["tts"] },
    ];
    expect(withCapability(models, "chat").map((m) => m.id)).toEqual(["flash"]);
    expect(withCapability(models, "tts").map((m) => m.id)).toEqual(["flash-tts"]);
    expect(withCapability(models, "stt").map((m) => m.id)).toEqual(["flash"]);
  });
});

describe("the bundled defaults", () => {
  it("never tags a text-to-speech model as something to think with", () => {
    const speech = Object.values(DEFAULT_MODELS)
      .flat()
      .filter((m) => m.capabilities.includes("tts"));
    expect(speech.filter((m) => m.capabilities.includes("chat"))).toEqual([]);
  });

  it("only uses capabilities the code knows", () => {
    for (const models of Object.values(DEFAULT_MODELS)) {
      for (const model of models) {
        expect(model.capabilities.every(isModelCapability)).toBe(true);
      }
    }
  });
});

describe("provider_models storage", () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yarvis-catalog-"));
    originalPath = process.env.YARVIS_SETTINGS_PATH;
    process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
    else process.env.YARVIS_SETTINGS_PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });

  it("lists no models initially", async () => {
    expect(await listProviderModels()).toEqual([]);
  });

  it("saves a model with the given fields", async () => {
    const saved = await saveProviderModel({
      providerId: "gemini",
      modelId: "gemini-3.5-flash",
      capabilities: ["chat", "vision"],
      enabled: false,
      sortOrder: 5,
    });
    expect(saved).toEqual({
      providerId: "gemini",
      modelId: "gemini-3.5-flash",
      capabilities: ["chat", "vision"],
      enabled: false,
      sortOrder: 5,
    });
    expect(await listProviderModels()).toEqual([saved]);
  });

  it("defaults enabled to true and sortOrder to 0 when omitted", async () => {
    const saved = await saveProviderModel({
      providerId: "gemini",
      modelId: "gemini-3.5-flash",
      capabilities: ["chat"],
    });
    expect(saved.enabled).toBe(true);
    expect(saved.sortOrder).toBe(0);
  });

  it("replaces the existing entry in place rather than duplicating it", async () => {
    await saveProviderModel({
      providerId: "gemini",
      modelId: "m",
      capabilities: ["chat"],
      sortOrder: 1,
    });
    await saveProviderModel({
      providerId: "gemini",
      modelId: "m",
      capabilities: ["chat", "vision"],
      sortOrder: 2,
    });
    const rows = await listProviderModels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      providerId: "gemini",
      modelId: "m",
      capabilities: ["chat", "vision"],
      enabled: true,
      sortOrder: 2,
    });
  });

  it("orders by providerId, then sortOrder, then modelId", async () => {
    await saveProviderModel({
      providerId: "gemini",
      modelId: "b",
      capabilities: ["chat"],
      sortOrder: 1,
    });
    await saveProviderModel({
      providerId: "anthropic",
      modelId: "z",
      capabilities: ["chat"],
      sortOrder: 0,
    });
    await saveProviderModel({
      providerId: "gemini",
      modelId: "a",
      capabilities: ["chat"],
      sortOrder: 1,
    });
    await saveProviderModel({
      providerId: "gemini",
      modelId: "c",
      capabilities: ["chat"],
      sortOrder: 0,
    });

    const rows = await listProviderModels();
    expect(rows.map((r) => [r.providerId, r.modelId])).toEqual([
      ["anthropic", "z"],
      ["gemini", "c"],
      ["gemini", "a"],
      ["gemini", "b"],
    ]);
  });

  it("deletes only the matching entry", async () => {
    await saveProviderModel({ providerId: "gemini", modelId: "keep", capabilities: ["chat"] });
    await saveProviderModel({ providerId: "gemini", modelId: "drop", capabilities: ["chat"] });

    const ok = await deleteProviderModel("gemini", "drop");
    expect(ok).toBe(true);
    expect((await listProviderModels()).map((r) => r.modelId)).toEqual(["keep"]);
  });

  it("returns false deleting an entry that does not exist", async () => {
    expect(await deleteProviderModel("gemini", "nope")).toBe(false);
  });

  it("clears every entry for a provider and reports how many were removed", async () => {
    await saveProviderModel({ providerId: "gemini", modelId: "a", capabilities: ["chat"] });
    await saveProviderModel({ providerId: "gemini", modelId: "b", capabilities: ["chat"] });
    await saveProviderModel({ providerId: "anthropic", modelId: "c", capabilities: ["chat"] });

    const removed = await resetProviderModels("gemini");
    expect(removed).toBe(2);

    const rows = await listProviderModels();
    expect(rows.map((r) => r.modelId)).toEqual(["c"]);
  });

  it("returns 0 resetting a provider with no entries", async () => {
    expect(await resetProviderModels("gemini")).toBe(0);
  });
});
