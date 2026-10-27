import { describe, expect, it } from "bun:test";
import { plainHoverText, safeHoverContents, withoutImages } from "./hoverSafety";

describe("withoutImages", () => {
  it("breaks inline, reference and shortcut images", () => {
    expect(withoutImages("see ![x](https://evil.example/p.png)")).toBe(
      "see !\\[x](https://evil.example/p.png)",
    );
    expect(withoutImages("![x][ref]\n\n[ref]: https://evil.example/p.png")).toBe(
      "!\\[x][ref]\n\n[ref]: https://evil.example/p.png",
    );
    expect(withoutImages("![ref]")).toBe("!\\[ref]");
  });

  it("breaks an image nested in a link", () => {
    expect(withoutImages("[![x](https://evil.example/p.png)](https://a.example)")).toBe(
      "[!\\[x](https://evil.example/p.png)](https://a.example)",
    );
  });

  it("leaves links and ordinary text alone", () => {
    const text = "Call [docs](https://example.com) now! [a] !important";
    expect(withoutImages(text)).toBe(text);
  });
});

describe("safeHoverContents", () => {
  it("escapes images and withdraws trust and HTML", () => {
    const parts: { value: string; isTrusted?: boolean; supportHtml?: boolean }[] = [
      { value: "![x](https://e.example/a.png)", isTrusted: true, supportHtml: true },
    ];
    const [part] = safeHoverContents(parts);
    expect(part).toEqual({
      value: "!\\[x](https://e.example/a.png)",
      isTrusted: false,
      supportHtml: false,
    });
  });
});

describe("plainHoverText", () => {
  it("breaks bare URLs, which GFM links with no brackets", () => {
    expect(plainHoverText("see https://3232235777/p")).toBe("see https\\://3232235777/p");
  });

  it("keeps the text on one line, so nothing can start a heading or code block", () => {
    expect(plainHoverText("title\n===\n    code")).toBe("title \\=\\=\\= code");
  });
});
