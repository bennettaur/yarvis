import { describe, expect, it } from "bun:test";
import { refApiPath, refDisplayRepo, refDomKey, refKey, refNumber } from "./ref";
import type { PrRef } from "./types";

const gh: PrRef = { provider: "github", owner: "acme", repo: "web", number: 7 };
const az: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web app", prId: 42 };

describe("ref helpers", () => {
  it("derives stable cache keys per provider", () => {
    expect(refKey(gh)).toBe("gh:acme/web/7");
    expect(refKey(az)).toBe("az:acme/Shop/web app/42");
  });

  it("produces DOM-safe ids", () => {
    expect(refDomKey(gh)).toBe("gh-acme-web-7");
    expect(refDomKey(az)).toBe("az-acme-Shop-web-app-42");
  });

  it("labels the repo per provider", () => {
    expect(refDisplayRepo(gh)).toBe("acme/web");
    expect(refDisplayRepo(az)).toBe("Shop/web app");
  });

  it("exposes the user-facing number", () => {
    expect(refNumber(gh)).toBe(7);
    expect(refNumber(az)).toBe(42);
  });

  it("builds encoded api paths (azure omits the org)", () => {
    expect(refApiPath(gh)).toBe("/api/github/pr/acme/web/7");
    expect(refApiPath(az)).toBe("/api/azure/pr/Shop/web%20app/42");
  });
});
