import { describe, expect, it } from "bun:test";
import { monacoLanguageForPath } from "./language";

describe("monacoLanguageForPath", () => {
  it("passes through names Monaco shares with highlight.js", () => {
    expect(monacoLanguageForPath("src/app.tsx")).toBe("typescript");
    expect(monacoLanguageForPath("main.go")).toBe("go");
    expect(monacoLanguageForPath("config.yml")).toBe("yaml");
  });

  it("renames the ones Monaco calls something else", () => {
    expect(monacoLanguageForPath("build.sh")).toBe("shell");
    expect(monacoLanguageForPath("api.proto")).toBe("proto");
    expect(monacoLanguageForPath("View.m")).toBe("objective-c");
  });

  it("gives HTML Monaco's own HTML mode rather than XML", () => {
    expect(monacoLanguageForPath("index.html")).toBe("html");
    expect(monacoLanguageForPath("icon.svg")).toBe("xml");
  });

  it("reads whole file names", () => {
    expect(monacoLanguageForPath("docker/Dockerfile")).toBe("dockerfile");
  });

  it("falls back to plain text", () => {
    expect(monacoLanguageForPath("Makefile")).toBe("plaintext");
    expect(monacoLanguageForPath("notes.unknownext")).toBe("plaintext");
    expect(monacoLanguageForPath("LICENSE")).toBe("plaintext");
  });
});
