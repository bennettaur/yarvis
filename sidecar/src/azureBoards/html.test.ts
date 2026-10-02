import { describe, expect, it } from "bun:test";
import { htmlToMarkdown, textToHtml } from "./html.ts";

describe("htmlToMarkdown", () => {
  it("returns an empty string for missing input", () => {
    expect(htmlToMarkdown(undefined)).toBe("");
    expect(htmlToMarkdown("")).toBe("");
  });

  it("turns the Azure editor's divs and breaks into lines", () => {
    expect(htmlToMarkdown("<div>First</div><div><br></div><div>Second</div>")).toBe(
      "First\n\nSecond",
    );
  });

  it("keeps emphasis, code, headings and lists", () => {
    const md = htmlToMarkdown(
      "<h2>Plan</h2><ul><li><b>one</b></li><li><i>two</i></li></ul><p>run <code>make</code></p>",
    );
    expect(md).toBe("## Plan\n\n- **one**\n- _two_\n\nrun `make`");
  });

  it("keeps web links and drops other schemes", () => {
    expect(htmlToMarkdown('<a href="https://x.dev/a">docs</a>')).toBe("[docs](https://x.dev/a)");
    expect(htmlToMarkdown('<a href="javascript:alert(1)">click</a>')).toBe("click");
  });

  it("drops script and style contents entirely", () => {
    expect(htmlToMarkdown("<script>alert(1)</script><style>p{}</style>ok")).toBe("ok");
  });

  it("decodes entities as text, so escaped markup stays visible", () => {
    expect(htmlToMarkdown("<div>a &lt;b&gt; &amp; c&nbsp;d &#39;e&#x27;</div>")).toBe(
      "a <b> & c d 'e'",
    );
  });

  it("turns an out-of-range numeric entity into a replacement character", () => {
    expect(htmlToMarkdown("a &#99999999; b")).toBe("a \uFFFD b");
  });

  it("keeps web images and drops other image sources", () => {
    expect(htmlToMarkdown('<img src="https://x.dev/a.png">')).toBe("![](https://x.dev/a.png)");
    expect(htmlToMarkdown('<img src="data:image/png;base64,AAAA">')).toBe("");
  });

  it("never lets a tag through, however the markup is nested or left open", () => {
    const crafted = [
      "<scr<b>ipt>alert(1)",
      "<scr<script></script>ipt>alert(1)</script>ok",
      "<sty<style></style>le>p{}</style>ok",
      "<script>alert(1)</script >ok",
      `${"<".repeat(50)}script${">".repeat(50)}x`,
      '<a href="https://x.dev"><i<b>mg src=x>go</a>',
      "<pre><scr<b>ipt>x</pre>",
      '<a href="https://x.dev"><img src="javascript:alert(1)">',
    ];
    for (const html of crafted) {
      expect(htmlToMarkdown(html)).not.toMatch(/<[^<>]*>/);
    }
  });

  it("drops script and style blocks even with whitespace in the closing tag", () => {
    expect(htmlToMarkdown("<script>alert(1)</script >ok")).toBe("ok");
    expect(htmlToMarkdown("<style>p{}</style>ok")).toBe("ok");
  });

  it("keeps escaped markup inside a code block as text", () => {
    expect(htmlToMarkdown("<pre>&lt;b&gt;bold&lt;/b&gt; &amp;lt;</pre>")).toBe(
      "```\n<b>bold</b> &lt;\n```",
    );
  });

  it("does not let entities in body text forge a second copy of a code block", () => {
    const out = htmlToMarkdown("<pre>X</pre>&#xE000;0&#xE000;");
    expect(out.match(/```/g)).toHaveLength(2);
  });

  it("stays linear on crafted unclosed tags", () => {
    const crafted = [
      '<a href="'.repeat(20_000),
      "<img src=''".repeat(20_000),
      "<".repeat(200_000),
      "<b>".repeat(60_000),
      `${"<scr<script></script>ipt>".repeat(5_000)}${"<script>".repeat(20_000)}`,
    ];
    for (const html of crafted) {
      const start = performance.now();
      htmlToMarkdown(html);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it("renders pre blocks as fenced code", () => {
    expect(htmlToMarkdown("<pre>line 1<br>line 2</pre>")).toBe("```\nline 1\nline 2\n```");
  });
});

describe("textToHtml", () => {
  it("escapes markup and wraps each line in a div", () => {
    expect(textToHtml("a <b>\n\nc & d")).toBe(
      "<div>a &lt;b&gt;</div><div><br></div><div>c &amp; d</div>",
    );
  });

  it("round-trips plain text through htmlToMarkdown", () => {
    const text = "Line one\n\nLine two";
    expect(htmlToMarkdown(textToHtml(text))).toBe(text);
  });
});
