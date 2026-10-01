import { describe, expect, it } from "bun:test";
import type { ProviderInfo } from "./chat";
import { hasConfiguredChatProvider } from "./onboarding";

const provider = (id: string, available: boolean): ProviderInfo =>
  ({ id, label: id, models: [], available }) as ProviderInfo;

describe("hasConfiguredChatProvider", () => {
  it("doesn't count Bedrock, which always reports available", () => {
    expect(hasConfiguredChatProvider([provider("bedrock", true)])).toBe(false);
  });

  it("counts any other available provider, custom ones included", () => {
    expect(
      hasConfiguredChatProvider([provider("bedrock", true), provider("custom:abc", true)]),
    ).toBe(true);
  });

  it("ignores providers with no key", () => {
    expect(hasConfiguredChatProvider([provider("anthropic", false)])).toBe(false);
  });
});
