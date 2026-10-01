import { afterEach, describe, expect, it } from "bun:test";
import type { AppPlace } from "../lib/appPlace";
import { onOpenPlace } from "../lib/nav";
import { mountForInteraction, renderToHtml } from "../test/render";
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

describe("Markdown allowAppLinks", () => {
  const PR = "[#12](https://github.com/o/r/pull/12)";

  it("offers a browser option beside a PR link", async () => {
    const html = await renderToHtml(<Markdown allowAppLinks>{PR}</Markdown>);
    expect(html).toContain('aria-label="Open in Yarvis: https://github.com/o/r/pull/12"');
    expect(html).toContain('aria-label="Open in browser"');
  });

  it("still shows the real destination on hover for a PR link", async () => {
    const html = await renderToHtml(<Markdown allowAppLinks>{PR}</Markdown>);
    expect(html).toContain('title="https://github.com/o/r/pull/12"');
  });

  it("leaves PR links alone unless the caller opts in", async () => {
    const html = await renderToHtml(<Markdown>{PR}</Markdown>);
    expect(html).not.toContain("Open in browser");
  });

  it("keeps other links as plain external links", async () => {
    const html = await renderToHtml(<Markdown allowAppLinks>{"[docs](https://a.test)"}</Markdown>);
    expect(html).toContain('title="https://a.test"');
    expect(html).not.toContain("Open in browser");
  });

  it("doesn't crash on a link with a malformed percent-escape", async () => {
    const html = await renderToHtml(
      <Markdown allowAppLinks>{"[deal](https://example.test/50%-off)"}</Markdown>,
    );
    expect(html).toContain("deal");
    expect(html).not.toContain("Open in browser");
  });
});

describe("Markdown yarvis:// links", () => {
  const LINK = "[Settings → Credentials](yarvis://settings/credentials)";
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("navigates in the app when clicked", async () => {
    const asked: AppPlace[] = [];
    const stop = onOpenPlace((place) => asked.push(place));
    const { host, unmount } = await mountForInteraction(<Markdown allowAppLinks>{LINK}</Markdown>);
    cleanup = () => {
      stop();
      unmount();
    };

    const link = host.querySelector("a");
    expect(link?.getAttribute("href")).toBe("yarvis://settings/credentials");
    link?.click();
    expect(asked).toEqual([{ kind: "settings", tab: "credentials" }]);
  });

  it("is dropped by the default URL filter unless the caller opts in", async () => {
    const html = await renderToHtml(<Markdown>{LINK}</Markdown>);
    expect(html).not.toContain("yarvis://");
  });
});
