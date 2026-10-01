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

  it("decodes entities after stripping tags, so escaped markup stays text", () => {
    expect(htmlToMarkdown("<div>a &lt;b&gt; &amp; c&nbsp;d &#39;e&#x27;</div>")).toBe(
      "a <b> & c d 'e'",
    );
  });

  it("leaves an out-of-range numeric entity as text instead of throwing", () => {
    expect(htmlToMarkdown("a &#99999999; b &#x110000;")).toBe("a &#99999999; b &#x110000;");
  });

  it("keeps web images and drops other image sources", () => {
    expect(htmlToMarkdown('<img src="https://x.dev/a.png">')).toBe("![](https://x.dev/a.png)");
    expect(htmlToMarkdown('<img src="data:image/png;base64,AAAA">')).toBe("");
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
