import { describe, expect, it } from "bun:test";
import { bunTarget, outfile } from "./compile-sidecar.ts";

describe("bunTarget", () => {
  it("maps each release triple to Bun's compile target", () => {
    expect(bunTarget("aarch64-apple-darwin")).toBe("bun-darwin-arm64");
    expect(bunTarget("x86_64-unknown-linux-gnu")).toBe("bun-linux-x64");
    expect(bunTarget("x86_64-pc-windows-msvc")).toBe("bun-windows-x64");
  });

  it("refuses a triple it has no target for, rather than building for the host", () => {
    expect(() => bunTarget("riscv64gc-unknown-linux-gnu")).toThrow();
  });
});

describe("outfile", () => {
  it("names the binary the way externalBin looks it up", () => {
    expect(outfile("aarch64-apple-darwin")).toBe(
      "src-tauri/binaries/yarvis-sidecar-aarch64-apple-darwin",
    );
  });

  it("adds .exe on Windows", () => {
    expect(outfile("x86_64-pc-windows-msvc")).toBe(
      "src-tauri/binaries/yarvis-sidecar-x86_64-pc-windows-msvc.exe",
    );
  });
});
