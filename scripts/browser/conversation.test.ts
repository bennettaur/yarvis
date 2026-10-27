import { describe, expect, it } from "bun:test";
import {
  MAX_SELECTION_CHARS,
  MAX_TAB_URL_CHARS,
  tabContext,
  titleFor,
} from "../../extension/conversation.js";

describe("tabContext", () => {
  it("describes the tab with the profile the browser tools expect", () => {
    expect(
      tabContext({ id: 7, url: "https://a.example/x", title: "A page" }, "  picked  ", "work"),
    ).toEqual({
      tabId: 7,
      url: "https://a.example/x",
      title: "A page",
      profile: "work",
      selection: "picked",
    });
  });

  it("leaves out an empty selection", () => {
    expect(tabContext({ id: 1, url: "", title: "" }, "   ", "work")).not.toHaveProperty(
      "selection",
    );
  });

  it("cuts values the sidecar would refuse", () => {
    const context = tabContext(
      { id: 1, url: `https://a.example/${"x".repeat(5000)}`, title: "t" },
      "y".repeat(5000),
      "work",
    );
    expect(context?.url).toHaveLength(MAX_TAB_URL_CHARS);
    expect(context?.selection).toHaveLength(MAX_SELECTION_CHARS);
  });

  it("is null without a tab id", () => {
    expect(tabContext(undefined, "", "work")).toBeNull();
    expect(tabContext({ url: "https://a.example" }, "", "work")).toBeNull();
  });
});

describe("titleFor", () => {
  it("uses the first line, shortened", () => {
    expect(titleFor("  what is this page?\nmore")).toBe("what is this page?");
    expect(titleFor("x".repeat(100))).toHaveLength(60);
  });
});
