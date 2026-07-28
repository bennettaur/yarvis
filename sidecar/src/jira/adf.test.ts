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

  it("normalizes CRLF to LF", () => {
    const doc = textToAdf("a\r\nb");
    expect(doc.content).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }],
      },
    ]);
  });
});

describe("adfToMarkdown block edge cases", () => {
  const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

  it("numbers ordered lists", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [para("first")] },
            { type: "listItem", content: [para("second")] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("1. first\n2. second");
  });

  it("renders blockquotes and horizontal rules", () => {
    const doc = {
      type: "doc",
      content: [{ type: "blockquote", content: [para("quoted")] }, { type: "rule" }],
    };
    expect(adfToMarkdown(doc)).toBe("> quoted\n\n---");
  });

  it("renders a table with a header row and escapes pipes and backslashes", () => {
    const cell = (text: string) => ({ type: "tableCell", content: [para(text)] });
    const doc = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            { type: "tableRow", content: [cell("a"), cell("b")] },
            // A literal backslash must be doubled before the pipe is escaped, so
            // "\" can't merge with the pipe escaping and corrupt the markup.
            { type: "tableRow", content: [cell("c | d"), cell("x\\y")] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("| a | b |\n| --- | --- |\n| c \\| d | x\\\\y |");
  });

  it("applies em/strike marks and falls back to bare text for a link without href", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "italic", marks: [{ type: "em" }] },
            { type: "text", text: " and " },
            { type: "text", text: "gone", marks: [{ type: "strike" }] },
            { type: "text", text: " and " },
            { type: "text", text: "plain", marks: [{ type: "link" }] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("*italic* and ~~gone~~ and plain");
  });
});
