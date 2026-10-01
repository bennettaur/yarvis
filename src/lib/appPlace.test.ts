import { describe, expect, it } from "bun:test";
import { parseAppPlace } from "./appPlace";

describe("parseAppPlace", () => {
  it("reads a Settings tab", () => {
    expect(parseAppPlace("yarvis://settings/credentials")).toEqual({
      kind: "settings",
      tab: "credentials",
    });
  });

  it("reads bare Settings as the Settings page", () => {
    expect(parseAppPlace("yarvis://settings")).toEqual({ kind: "tab", tab: "settings" });
  });

  it("reads a nav tab, with or without a trailing slash", () => {
    expect(parseAppPlace("yarvis://tab/prs")).toEqual({ kind: "tab", tab: "prs" });
    expect(parseAppPlace("yarvis://tab/prs/")).toEqual({ kind: "tab", tab: "prs" });
  });

  it("reads the two guides", () => {
    expect(parseAppPlace("yarvis://setup")).toEqual({ kind: "setup" });
    expect(parseAppPlace("yarvis://tour")).toEqual({ kind: "tour" });
  });

  it("refuses anything it doesn't know rather than guessing", () => {
    expect(parseAppPlace("yarvis://settings/nope")).toBeNull();
    expect(parseAppPlace("yarvis://tab/nope")).toBeNull();
    expect(parseAppPlace("yarvis://tab/prs/extra")).toBeNull();
    expect(parseAppPlace("yarvis://setup/extra")).toBeNull();
    expect(parseAppPlace("https://example.test")).toBeNull();
    expect(parseAppPlace(undefined)).toBeNull();
  });
});
