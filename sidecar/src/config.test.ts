import { afterEach, describe, expect, it } from "bun:test";
import {
  loadInstanceConfig,
  parseAllowedChatIds,
  parseBackgroundWorkers,
  parseInstanceName,
  parseOtpWindowMinutes,
} from "./config.ts";

describe("parseAllowedChatIds", () => {
  it("parses a comma-separated list, dropping malformed entries", () => {
    expect(parseAllowedChatIds("42, 7 ,abc, 9")).toEqual([42, 7, 9]);
  });

  it("returns an empty list for undefined or empty input", () => {
    expect(parseAllowedChatIds(undefined)).toEqual([]);
    expect(parseAllowedChatIds("   ")).toEqual([]);
  });

  it("accepts negative ids (groups) but drops non-integers", () => {
    expect(parseAllowedChatIds("-100123, 4.5, 8")).toEqual([-100123, 8]);
  });
});

describe("parseOtpWindowMinutes", () => {
  it("defaults to 120 for missing, zero, negative, or non-numeric input", () => {
    expect(parseOtpWindowMinutes(undefined)).toBe(120);
    expect(parseOtpWindowMinutes("0")).toBe(120);
    expect(parseOtpWindowMinutes("-5")).toBe(120);
    expect(parseOtpWindowMinutes("abc")).toBe(120);
  });

  it("floors a valid value", () => {
    expect(parseOtpWindowMinutes("90")).toBe(90);
    expect(parseOtpWindowMinutes("45.9")).toBe(45);
  });

  it("clamps absurdly large values to one week", () => {
    expect(parseOtpWindowMinutes("999999")).toBe(7 * 24 * 60);
  });
});

describe("parseInstanceName", () => {
  it("falls back to the primary instance when unnamed", () => {
    expect(parseInstanceName(undefined)).toBe("main");
    expect(parseInstanceName("   ")).toBe("main");
  });

  it("trims a supplied name", () => {
    expect(parseInstanceName(" feature-x ")).toBe("feature-x");
  });
});

describe("parseBackgroundWorkers", () => {
  it("recognizes both spellings of on and off, in any case", () => {
    expect(parseBackgroundWorkers("1", "feature-x")).toBe(true);
    expect(parseBackgroundWorkers(" TRUE ", "feature-x")).toBe(true);
    expect(parseBackgroundWorkers("0", "main")).toBe(false);
    expect(parseBackgroundWorkers(" False ", "main")).toBe(false);
  });

  it("falls back to the instance name when the switch is absent", () => {
    expect(parseBackgroundWorkers(undefined, "main")).toBe(true);
    expect(parseBackgroundWorkers(undefined, "feature-x")).toBe(false);
  });

  it("treats an unrecognized value as off rather than assuming ownership", () => {
    expect(parseBackgroundWorkers("yes", "main")).toBe(false);
  });
});

describe("loadInstanceConfig", () => {
  // Reads process.env directly, so each case restores what it changed —
  // the variable names are a contract with `src-tauri/src/sidecar.rs`.
  const original = {
    instance: process.env.YARVIS_INSTANCE,
    workers: process.env.YARVIS_BACKGROUND_WORKERS,
  };

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(() => {
    restore("YARVIS_INSTANCE", original.instance);
    restore("YARVIS_BACKGROUND_WORKERS", original.workers);
  });

  it("reads the instance the core named and the switch it set", () => {
    process.env.YARVIS_INSTANCE = "migration-test";
    process.env.YARVIS_BACKGROUND_WORKERS = "0";
    expect(loadInstanceConfig()).toEqual({ name: "migration-test", backgroundWorkers: false });
  });

  it("is the primary instance running its workers when the core set neither", () => {
    delete process.env.YARVIS_INSTANCE;
    delete process.env.YARVIS_BACKGROUND_WORKERS;
    expect(loadInstanceConfig()).toEqual({ name: "main", backgroundWorkers: true });
  });

  it("leaves the workers off for a named instance whose switch never arrived", () => {
    process.env.YARVIS_INSTANCE = "migration-test";
    delete process.env.YARVIS_BACKGROUND_WORKERS;
    expect(loadInstanceConfig().backgroundWorkers).toBe(false);
  });
});
