import { afterEach, describe, expect, it } from "bun:test";
import { matchRanges } from "./matches";
import { indexPageText, rangeFor } from "./pageText";

let host: HTMLElement | null = null;

function mount(html: string): HTMLElement {
  host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

/** The text a query selects, as the browser would report the built range. */
function selectedText(root: HTMLElement, query: string): string[] {
  const page = indexPageText(root);
  return matchRanges(page.text, query)
    .map((match) => rangeFor(page, match))
    .map((range) => range?.toString() ?? "<unmapped>");
}

afterEach(() => {
  host?.remove();
  host = null;
});

describe("indexPageText", () => {
  it("runs inline elements together and separates blocks", () => {
    const root = mount("<p>Hello <strong>world</strong></p><p>again</p>");
    expect(indexPageText(root).text).toBe("Hello world\nagain");
  });

  it("skips script and style contents", () => {
    const root = mount("<style>.a{color:red}</style><p>visible</p>");
    expect(indexPageText(root).text).toBe("visible");
  });

  it("skips subtrees hidden with display:none", () => {
    const root = mount('<p>shown</p><div style="display:none"><p>hidden</p></div>');
    expect(indexPageText(root).text).toBe("shown");
  });

  it("skips decorative text marked aria-hidden", () => {
    const root = mount('<p>real</p><span aria-hidden="true">★</span>');
    expect(indexPageText(root).text).toBe("real");
  });

  // Two words in adjacent blocks never appear side by side on screen, so a query
  // spanning them would highlight nothing the user could see.
  it("does not let a match span a block boundary", () => {
    const root = mount("<p>foo</p><p>bar</p>");
    expect(selectedText(root, "foobar")).toEqual([]);
  });
});

describe("rangeFor", () => {
  it("maps a match back onto the text it covers", () => {
    const root = mount("<p>alpha beta gamma</p>");
    expect(selectedText(root, "beta")).toEqual(["beta"]);
  });

  it("maps a match that straddles two text nodes", () => {
    const root = mount("<p>al<em>pha</em> beta</p>");
    expect(selectedText(root, "alpha")).toEqual(["alpha"]);
  });

  it("maps every occurrence separately", () => {
    const root = mount("<p>beta</p><p>and <b>beta</b></p>");
    expect(selectedText(root, "beta")).toEqual(["beta", "beta"]);
  });
});
