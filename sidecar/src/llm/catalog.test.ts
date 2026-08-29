import { describe, expect, it } from "bun:test";
import type { ProviderModelRow } from "../db/schema.ts";
import {
  catalogFor,
  DEFAULT_MODELS,
  isModelCapability,
  type ModelInfo,
  withCapability,
} from "./catalog.ts";

function row(partial: Partial<ProviderModelRow> & { providerId: string; modelId: string }) {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    capabilities: ["chat"],
    enabled: true,
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
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
