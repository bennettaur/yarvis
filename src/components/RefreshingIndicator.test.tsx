import { describe, expect, it } from "bun:test";
import { renderToHtml, textOf } from "../test/render";
import RefreshingIndicator from "./RefreshingIndicator";

describe("RefreshingIndicator", () => {
  it("says a list is being brought up to date", async () => {
    const html = await renderToHtml(<RefreshingIndicator active />);

    expect(textOf(html)).toContain("Refreshing…");
    // Announced rather than only drawn: the list under it does not visibly
    // change while the refresh runs, so a reader who can't see the pulse gets
    // nothing otherwise.
    expect(html).toContain('role="status"');
  });

  it("says nothing when no refresh is running", async () => {
    const html = await renderToHtml(<RefreshingIndicator active={false} />);

    expect(textOf(html)).toBe("");
  });
});
