import { describe, expect, it } from "bun:test";
import type { ProviderInfo } from "./chat";
import {
  hasConfiguredChatProvider,
  markSetupGuideSeen,
  SETUP_GUIDE_SEEN_KEY,
  setupGuideNeeded,
  shouldAutoOpenSetupGuide,
} from "./onboarding";

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

describe("setupGuideNeeded", () => {
  const keyed = [provider("anthropic", true)];

  it("never opens once the guide has been closed", () => {
    expect(setupGuideNeeded({ seen: true, databaseConfigured: false, providers: [] })).toBe(false);
  });

  it("opens when the database isn't configured", () => {
    expect(setupGuideNeeded({ seen: false, databaseConfigured: false, providers: keyed })).toBe(
      true,
    );
  });

  it("opens when Bedrock is the only provider", () => {
    expect(
      setupGuideNeeded({
        seen: false,
        databaseConfigured: true,
        providers: [provider("bedrock", true)],
      }),
    ).toBe(true);
  });

  it("stays closed for an install with a database and a keyed provider", () => {
    expect(setupGuideNeeded({ seen: false, databaseConfigured: true, providers: keyed })).toBe(
      false,
    );
  });
});

describe("shouldAutoOpenSetupGuide", () => {
  it("doesn't open, or ask the sidecar, once the guide has been closed", async () => {
    markSetupGuideSeen();
    try {
      // With the sidecar unreachable in tests, any request would reject.
      expect(await shouldAutoOpenSetupGuide()).toBe(false);
    } finally {
      localStorage.removeItem(SETUP_GUIDE_SEEN_KEY);
    }
  });
});
