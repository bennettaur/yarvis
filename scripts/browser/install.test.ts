import { describe, expect, it } from "bun:test";
import { hostManifest, wrapperScript } from "./install.ts";

describe("browser host install", () => {
  it("allows only the named extension ids to start the host", () => {
    const manifest = hostManifest("/h/host", ["a".repeat(32)]);
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${"a".repeat(32)}/`]);
    expect(manifest.path).toBe("/h/host");
    expect(manifest.type).toBe("stdio");
  });

  it("pins Bun's absolute path in the wrapper", () => {
    expect(wrapperScript("/opt/bun", "/repo/host.ts")).toBe(
      '#!/bin/sh\nexec "/opt/bun" "/repo/host.ts"\n',
    );
  });
});
