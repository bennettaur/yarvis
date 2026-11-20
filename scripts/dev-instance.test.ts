import { describe, expect, it } from "bun:test";
import { childEnv, identifierFor, overrideConfig, slugify } from "./dev-instance.ts";

describe("slugify", () => {
  it("reduces a branch-shaped name to something a bundle identifier accepts", () => {
    expect(slugify("Feature/X_1")).toBe("feature-x-1");
  });

  it("caps length so the single-instance socket path stays bindable", () => {
    const slug = slugify("a-very-long-branch-name-".repeat(10));
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("rejects a name with nothing usable in it", () => {
    expect(() => slugify("///")).toThrow();
  });
});

describe("overrideConfig", () => {
  it("namespaces the identifier under the primary one", () => {
    expect(overrideConfig("feature-x-1").identifier).toBe("com.mikebennett.yarvis.feature-x-1");
  });

  it("leaves the window config alone, since merging would replace it wholesale", () => {
    expect(overrideConfig("dev")).not.toHaveProperty("app");
  });
});

describe("identifierFor", () => {
  it("formats an already-slugged name under the base identifier", () => {
    expect(identifierFor("dev")).toBe("com.mikebennett.yarvis.dev");
  });
});

describe("childEnv", () => {
  it("names the instance so the core knows it is not the primary", () => {
    expect(childEnv("migration-test").YARVIS_INSTANCE).toBe("migration-test");
  });
});
