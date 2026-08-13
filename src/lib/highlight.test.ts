import { describe, expect, it } from "bun:test";
import { highlightLines, languageForPath } from "./highlight";

describe("languageForPath", () => {
  it("reads the extension off the last path segment", () => {
    expect(languageForPath("src/components/pr/PrFileDiffs.tsx")).toBe("typescript");
    expect(languageForPath("sidecar/src/pr/ask.ts")).toBe("typescript");
    expect(languageForPath("src-tauri/src/main.rs")).toBe("rust");
  });

  it("matches extensions case-insensitively", () => {
    expect(languageForPath("Main.PY")).toBe("python");
  });

  it("recognizes the filenames that carry the language themselves", () => {
    expect(languageForPath("docker/Dockerfile")).toBe("dockerfile");
    expect(languageForPath("Gemfile")).toBe("ruby");
  });

  it("has no language for extensions we carry no grammar for", () => {
    expect(languageForPath("main.tf")).toBeNull();
    expect(languageForPath("notes.txt")).toBeNull();
    expect(languageForPath("LICENSE")).toBeNull();
  });

  // A dotfile's leading dot is not an extension separator — treating it as one
  // would look up "gitignore" as a language.
  it("does not read a dotfile's name as an extension", () => {
    expect(languageForPath(".gitignore")).toBeNull();
  });
});

describe("highlightLines", () => {
  it("returns one entry per line of the input", () => {
    const lines = highlightLines("const a = 1;\nconst b = 2;\n", "typescript");
    expect(lines).toHaveLength(3);
  });

  it("colors the tokens it recognizes", () => {
    const lines = highlightLines("const a = 1;", "typescript");
    expect(lines?.[0]).toContain("hljs-keyword");
  });

  // A block comment is one highlight.js span across several lines, but each
  // line is rendered as its own element, so every line has to be valid markup
  // on its own.
  it("closes and reopens spans that straddle a line break", () => {
    const lines = highlightLines("/* one\n   two */\nconst a = 1;", "typescript");
    expect(lines).toHaveLength(3);
    for (const line of lines ?? []) {
      const opens = line.match(/<span/g)?.length ?? 0;
      const closes = line.match(/<\/span>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
    expect(lines?.[0]).toContain("hljs-comment");
    expect(lines?.[1]).toContain("hljs-comment");
  });

  it("escapes the source it wraps", () => {
    const lines = highlightLines('const html = "<script>";', "typescript");
    expect(lines?.[0]).not.toContain("<script>");
    expect(lines?.[0]).toContain("&lt;script&gt;");
  });

  it("keeps going through code that does not parse", () => {
    const lines = highlightLines("function (] {\nconst a = 1;", "typescript");
    expect(lines).toHaveLength(2);
  });

  it("declines a language it has no grammar for", () => {
    expect(highlightLines("x = 1", "brainfuck")).toBeNull();
  });

  it("declines a document too large to be worth tokenizing", () => {
    expect(highlightLines("x".repeat(400_001), "typescript")).toBeNull();
  });
});
