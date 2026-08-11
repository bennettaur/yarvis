import { describe, expect, it } from "bun:test";
import {
  childEnv,
  devPortFor,
  identifierFor,
  overrideConfig,
  resolveDevPort,
  slugify,
} from "./dev-instance.ts";

/** Stands in for a real bind attempt, so the tests never touch the network. */
const freeExcept = (taken: number[]) => async (port: number) => !taken.includes(port);

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

describe("devPortFor", () => {
  it("is stable for a slug, so relaunching keeps the same dev URL", () => {
    expect(devPortFor("migration-test")).toBe(devPortFor("migration-test"));
  });

  it("agrees with the identifier: one app data directory, one port", () => {
    // Two spellings that slug the same share a bundle identifier, so they must
    // not be handed two different ports.
    expect(devPortFor(slugify("Feature/X"))).toBe(devPortFor(slugify("feature-x")));
  });

  it("leaves the odd port of each pair free for the HMR socket", () => {
    for (const name of ["a", "migration-test", "feature-long-branch-name", "zzz"]) {
      const port = devPortFor(name);
      expect(port).toBeGreaterThanOrEqual(1430);
      expect(port).toBeLessThan(1490);
      expect(port % 2).toBe(0);
    }
  });

  it("separates slugs sharing a prefix", () => {
    expect(devPortFor("feature-a")).not.toBe(devPortFor("feature-b"));
  });
});

describe("resolveDevPort", () => {
  it("keeps the preferred port when its pair is free", async () => {
    expect(await resolveDevPort(1436, freeExcept([]))).toBe(1436);
  });

  it("skips a pair whose HMR port is taken, not just its dev port", async () => {
    expect(await resolveDevPort(1436, freeExcept([1437]))).toBe(1438);
  });

  it("moves to the next free pair rather than failing the launch", async () => {
    expect(await resolveDevPort(1436, freeExcept([1436, 1438]))).toBe(1440);
  });

  it("wraps to the start of the range before giving up", async () => {
    expect(await resolveDevPort(1488, freeExcept([1488]))).toBe(1430);
  });

  it("reports exhaustion instead of returning a port it cannot bind", async () => {
    await expect(resolveDevPort(1436, async () => false)).rejects.toThrow(/no free port pair/);
  });
});

describe("overrideConfig", () => {
  it("namespaces the identifier under the primary one", () => {
    expect(overrideConfig("feature-x-1", 1436).identifier).toBe(
      "com.mikebennett.yarvis.feature-x-1",
    );
  });

  it("points the webview at this instance's dev server", () => {
    expect(overrideConfig("dev", 1436).build.devUrl).toBe("http://localhost:1436");
  });

  it("leaves the window config alone, since merging would replace it wholesale", () => {
    expect(overrideConfig("dev", 1436)).not.toHaveProperty("app");
  });
});

describe("identifierFor", () => {
  it("formats an already-slugged name under the base identifier", () => {
    expect(identifierFor("dev")).toBe("com.mikebennett.yarvis.dev");
  });
});

describe("childEnv", () => {
  it("hands the child the same port the webview is told to load from", () => {
    const port = 1436;
    expect(childEnv("dev", port).YARVIS_DEV_PORT).toBe(
      new URL(overrideConfig("dev", port).build.devUrl).port,
    );
  });

  it("names the instance so the core knows it is not the primary", () => {
    expect(childEnv("migration-test", 1436).YARVIS_INSTANCE).toBe("migration-test");
  });
});
