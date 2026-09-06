import { afterEach, describe, expect, it } from "bun:test";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";
import ErrorNotice from "./ErrorNotice";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("ErrorNotice", () => {
  it("shows the message and keeps the detail collapsed", async () => {
    const html = await renderToHtml(
      <ErrorNotice error={{ message: "chat failed (400)", detail: "status=400 body=nope" }} />,
    );
    expect(textOf(html)).toContain("chat failed (400)");
    expect(textOf(html)).toContain("Show details");
    expect(textOf(html)).not.toContain("body=nope");
  });

  it("offers no disclosure when there is nothing more to say", async () => {
    const html = await renderToHtml(<ErrorNotice error={{ message: "offline" }} />);
    expect(textOf(html)).not.toContain("Show details");
  });

  it("reveals the full diagnosis when expanded", async () => {
    const mounted = await mountForInteraction(
      <ErrorNotice
        error={{ message: "chat failed", detail: "url=https://gateway/v1/responses" }}
      />,
    );
    cleanup = mounted.unmount;
    const toggle = mounted.host.querySelector<HTMLButtonElement>("button[aria-expanded]");
    toggle?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mounted.host.textContent).toContain("url=https://gateway/v1/responses");
  });
});
