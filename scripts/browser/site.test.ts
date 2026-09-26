import { describe, expect, it } from "bun:test";
import { isBlockedLabel, sameOrigin } from "../../extension/site.js";

describe("sameOrigin", () => {
  it("accepts pages on the same origin, whatever the path", () => {
    expect(
      sameOrigin("https://app.slack.com/client/T1/C1", "https://app.slack.com/client/T1/C2"),
    ).toBe(true);
  });

  it("refuses another host, subdomain, scheme or port", () => {
    expect(sameOrigin("https://app.slack.com/a", "https://evil.com/a")).toBe(false);
    expect(sameOrigin("https://app.slack.com/a", "https://acme.slack.com/a")).toBe(false);
    expect(sameOrigin("https://app.slack.com/a", "http://app.slack.com/a")).toBe(false);
    expect(sameOrigin("https://app.slack.com/a", "https://app.slack.com:8443/a")).toBe(false);
  });

  it("refuses a lookalike host and non-web schemes", () => {
    expect(sameOrigin("https://slack.com/a", "https://slack.com.evil.com/a")).toBe(false);
    expect(sameOrigin("https://slack.com/a", "https://slack.com@evil.com/a")).toBe(false);
    expect(sameOrigin("javascript:void(0)", "javascript:void(0)")).toBe(false);
    expect(sameOrigin("chrome://settings", "chrome://settings")).toBe(false);
    expect(sameOrigin("https://slack.com/a", "not a url")).toBe(false);
  });
});

describe("isBlockedLabel", () => {
  it("blocks controls that send or change things", () => {
    for (const label of ["Send", "Delete message", "Leave channel", "Post", "Sign out"]) {
      expect(isBlockedLabel(label)).toBe(true);
    }
  });

  it("lets navigation labels through", () => {
    for (const label of ["general", "Threads", "Direct messages", "3 replies", "Home"]) {
      expect(isBlockedLabel(label)).toBe(false);
    }
  });
});
