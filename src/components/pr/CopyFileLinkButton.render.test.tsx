import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrRef } from "../../lib/pr/types";
import { clipboardWrites, resetClipboardWrites } from "../../test/clipboard";
import { mountForInteraction, renderToHtml } from "../../test/render";

// Imported after the shared clipboard stub so it is in place.
const { default: CopyFileLinkButton } = await import("./CopyFileLinkButton");
const { default: CopyPathButton } = await import("./CopyPathButton");

const githubRef: PrRef = { provider: "github", owner: "octo", repo: "web", number: 7 };

type Props = { prRef?: PrRef; prUrl?: string; headSha?: string; path?: string };

const element = (props: Props = {}) =>
  createElement(CopyFileLinkButton, {
    prRef: props.prRef ?? githubRef,
    prUrl: props.prUrl ?? "https://github.com/octo/web/pull/7",
    headSha: props.headSha ?? "abc123",
    path: props.path ?? "src/a.ts",
  });

const render = (props: Props = {}) => renderToHtml(element(props));

let unmount: (() => void) | null = null;

beforeEach(resetClipboardWrites);

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("CopyFileLinkButton", () => {
  // It sits right next to CopyPathButton in the file list and diff header —
  // without a distinct glyph a reader can't tell which button copies what (#289).
  it("renders a different idle icon than CopyPathButton", async () => {
    const iconOf = (html: string) => /<svg[^>]*>.*?<\/svg>/s.exec(html)?.[0];
    const pathIcon = iconOf(
      await renderToHtml(createElement(CopyPathButton, { path: "src/a.ts" })),
    );
    const linkIcon = iconOf(await render());
    expect(pathIcon).toBeTruthy();
    expect(linkIcon).toBeTruthy();
    expect(linkIcon).not.toBe(pathIcon);
  });

  it("names the provider and the file it copies a link to", async () => {
    const html = await render();
    expect(html).toContain("Copy the GitHub link to src/a.ts");
  });

  // The URL lives in a closure, so only a click proves the wiring — that the
  // provider, head commit and path reach `prFileUrl` in the right places.
  it("copies the file's link at the PR's head commit", async () => {
    const mounted = await mountForInteraction(element({ path: "src/deep/a.ts" }));
    unmount = mounted.unmount;
    mounted.host.querySelector("button")?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clipboardWrites()).toEqual(["https://github.com/octo/web/blob/abc123/src/deep/a.ts"]);
  });

  // Nothing here should render a button that copies a link to the wrong file.
  it("renders nothing before the head commit is known", async () => {
    expect(await render({ headSha: "" })).toBe("");
  });

  it("renders nothing when the PR URL isn't the provider's shape", async () => {
    expect(await render({ prUrl: "https://github.com/octo/web" })).toBe("");
  });
});
