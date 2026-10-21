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
    expect(htmlToMarkdown("<script>alert(1)</script >ok")).toBe("ok");
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

  it("keeps escaped markup inside a code block as text", () => {
    expect(htmlToMarkdown("<pre>&lt;b&gt;bold&lt;/b&gt; &amp;lt;</pre>")).toBe(
      "```\n<b>bold</b> &lt;\n```",
    );
  });

  it.each([
    ["unclosed hrefs", '<a href="'.repeat(20_000)],
    ["unclosed srcs", "<img src=''".repeat(20_000)],
    ["bare brackets", "<".repeat(200_000)],
    ["unclosed bold", "<b>".repeat(60_000)],
    ["spliced scripts", `${"<scr<script></script>ipt>".repeat(5_000)}${"<script>".repeat(20_000)}`],
  ])("stays fast on crafted %s", (_name, html) => {
    const start = performance.now();
    htmlToMarkdown(html);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("closes a link and a code block left open at the end", () => {
    expect(htmlToMarkdown('<a href="https://x.dev">open label')).toBe(
      "[open label](https://x.dev/)",
    );
    expect(htmlToMarkdown("<pre>unclosed <b>x")).toBe("```\nunclosed x\n```");
  });

  it("closes the first link when a second one opens", () => {
    expect(
      htmlToMarkdown('<a href="https://a.dev">one <a href="https://b.dev">two</a> three</a>'),
    ).toBe("[one](https://a.dev/)[two](https://b.dev/) three");
  });

  it("keeps a crafted href from closing the link and opening another", () => {
    expect(htmlToMarkdown('<a href="https://a.dev/x)[e](javascript:alert(1))">lbl</a>')).toBe(
      "[lbl](https://a.dev/x%29[e]%28javascript:alert%281%29%29)",
    );
    expect(htmlToMarkdown('<a href="https://a.dev">a]b</a>')).toBe("[a\\]b](https://a.dev/)");
    expect(htmlToMarkdown('<a href="https://a.dev">a\\]b</a>')).toBe("[a\\\\\\]b](https://a.dev/)");
  });

  it("makes a code fence longer than any backtick run in the code", () => {
    expect(htmlToMarkdown("<pre>```\nafter</pre>")).toBe("````\n```\nafter\n````");
  });

  // A code block inside a link breaks the link; pinned until that's handled.
  it("writes a code block inside a link into the link label", () => {
    expect(htmlToMarkdown('<a href="https://a.dev">x<pre>code</pre>y</a>')).toBe(
      "[x\n\n```\ncode\n```\n\ny](https://a.dev/)",
    );
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
