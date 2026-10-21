import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_ITEMS } from "../components/shell/nav";
import { parseAppPlace } from "./appPlace";
import { SETTINGS_TABS } from "./settingsTabs";

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

describe("the yarvis-guide specialist's link list", () => {
  // The guide's prompt lists every valid yarvis:// address by hand, because the
  // sidecar can't import the frontend's tab lists. This keeps the two in step.
  const prompt = readFileSync(
    join(import.meta.dir, "../../sidecar/src/agents/definitions/yarvis-guide.md"),
    "utf8",
  );
  const links = [...prompt.matchAll(/yarvis:\/\/[a-z/]*[a-z]/g)].map((m) => m[0]);

  it("names only addresses the app can open", () => {
    expect(links.length).toBeGreaterThan(0);
    const unparsed = links.filter((link) => parseAppPlace(link) === null);
    expect(unparsed).toEqual([]);
  });

  it("names every Settings tab and every page", () => {
    for (const { key } of SETTINGS_TABS) expect(links).toContain(`yarvis://settings/${key}`);
    for (const { id } of NAV_ITEMS) {
      if (id !== "settings") expect(links).toContain(`yarvis://tab/${id}`);
    }
  });
});
