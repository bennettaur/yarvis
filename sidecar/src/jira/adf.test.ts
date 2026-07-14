import { describe, expect, it } from "bun:test";
import { adfToMarkdown, textToAdf } from "./adf.ts";

describe("adfToMarkdown", () => {
  it("renders paragraphs with inline marks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " and " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("Hello **bold** and `code`");
  });

  it("renders links, headings, and lists", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "site",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
            },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("## Title\n\n[site](https://example.com)\n\n- one\n- two");
  });

  it("renders code blocks with language", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("```ts\nconst x = 1;\n```");
  });

  it("renders mentions and hard breaks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { text: "@Jane" } },
            { type: "hardBreak" },
            { type: "text", text: "line two" },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("@Jane\nline two");
  });

  it("returns empty string for null/empty documents", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown({ type: "doc", content: [] })).toBe("");
  });

  it("recurses through unknown block nodes rather than dropping text", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "someFutureNode",
          content: [{ type: "paragraph", content: [{ type: "text", text: "kept" }] }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("kept");
  });
});

describe("textToAdf", () => {
  it("splits blank lines into paragraphs and single newlines into hard breaks", () => {
    const doc = textToAdf("line one\nline two\n\nsecond para");
    expect(doc.content).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "line one" },
          { type: "hardBreak" },
          { type: "text", text: "line two" },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "second para" }] },
    ]);
  });

  it("yields an empty document for blank input", () => {
    expect(textToAdf("   ")).toEqual({ version: 1, type: "doc", content: [] });
  });

  it("round-trips plain multi-paragraph text through adfToMarkdown", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    expect(adfToMarkdown(textToAdf(text))).toBe(text);
  });
});
