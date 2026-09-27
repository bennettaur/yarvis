import { describe, expect, it } from "bun:test";
import { renderToHtml } from "../test/render";
import Markdown from "./Markdown";

const IMAGE = "![diagram](https://example.test/d.png)";

describe("Markdown", () => {
  it("loads images inline only where the caller opts in", async () => {
    const html = await renderToHtml(<Markdown allowImages>{IMAGE}</Markdown>);
    expect(html).toContain("<img ");
    expect(html).toContain('src="https://example.test/d.png"');
  });

  it("stands a placeholder in for an image by default", async () => {
    const html = await renderToHtml(<Markdown>{IMAGE}</Markdown>);
    expect(html).not.toContain("<img");
    expect(html).toContain("diagram");
    expect(html).toContain('title="https://example.test/d.png"');
  });

  it("keeps a single newline a line break, the way GitHub renders one", async () => {
    const html = await renderToHtml(<Markdown>{"first\nsecond"}</Markdown>);
    expect(html).toContain("<br");
  });

  it("shows a link's destination so the text can't misrepresent it", async () => {
    const html = await renderToHtml(<Markdown>{"[docs](https://a.test)"}</Markdown>);
    expect(html).toContain('href="https://a.test"');
    expect(html).toContain('title="https://a.test"');
  });
});

describe("Markdown appLinks", () => {
  const PR = "[#12](https://github.com/o/r/pull/12)";

  it("offers a browser option beside a PR link", async () => {
    const html = await renderToHtml(<Markdown appLinks>{PR}</Markdown>);
    expect(html).toContain('title="Open in Yarvis"');
    expect(html).toContain('aria-label="Open in browser"');
  });

  it("leaves PR links alone unless the caller opts in", async () => {
    const html = await renderToHtml(<Markdown>{PR}</Markdown>);
    expect(html).not.toContain("Open in browser");
  });

  it("keeps other links as plain external links", async () => {
    const html = await renderToHtml(<Markdown appLinks>{"[docs](https://a.test)"}</Markdown>);
    expect(html).toContain('title="https://a.test"');
    expect(html).not.toContain("Open in browser");
  });
});
