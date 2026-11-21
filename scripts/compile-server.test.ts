import { describe, expect, it } from "bun:test";
import { builtPath, outfile } from "./compile-server.ts";

describe("compile-server paths", () => {
  it("copies from cargo's per-target release dir", () => {
    expect(builtPath("aarch64-apple-darwin")).toBe(
      "server/target/aarch64-apple-darwin/release/yarvis-server",
    );
  });

  it("names the binary the way externalBin looks it up", () => {
    expect(outfile("aarch64-apple-darwin")).toBe(
      "src-tauri/binaries/yarvis-server-aarch64-apple-darwin",
    );
  });

  it("adds .exe on Windows", () => {
    expect(outfile("x86_64-pc-windows-msvc")).toBe(
      "src-tauri/binaries/yarvis-server-x86_64-pc-windows-msvc.exe",
    );
    expect(builtPath("x86_64-pc-windows-msvc")).toEndWith("yarvis-server.exe");
  });
});
