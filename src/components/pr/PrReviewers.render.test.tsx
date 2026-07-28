import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { Reviewer } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";
import { ReviewersList } from "./PrReviewers";

const reviewer = (over: Partial<Reviewer> = {}): Reviewer => ({
  login: "alice",
  state: "pending",
  isRequested: true,
  ...over,
});

const render = (reviewers: Reviewer[]) => renderToHtml(createElement(ReviewersList, { reviewers }));

describe("ReviewersList", () => {
  it("renders the empty-state hint when no reviewers are attached", async () => {
    const html = await render([]);
    expect(html).toContain("No reviewers requested");
  });

  it("labels each reviewer with the correct verdict badge", async () => {
    const html = await render([
      reviewer({ login: "a", state: "approved", isRequested: false }),
      reviewer({ login: "b", state: "changes_requested", isRequested: false }),
      reviewer({ login: "c", state: "commented", isRequested: false }),
      reviewer({ login: "d", state: "pending", isRequested: true }),
      reviewer({ login: "e", state: "dismissed", isRequested: false }),
    ]);
    expect(html).toContain("Approved");
    expect(html).toContain("Changes requested");
    expect(html).toContain("Commented");
    expect(html).toContain("Awaiting review");
    expect(html).toContain("Dismissed");
  });

  it("sorts outstanding requests first, then changes_requested, approved, commented, dismissed", async () => {
    const html = await render([
      reviewer({ login: "approver", state: "approved", isRequested: false }),
      reviewer({ login: "commenter", state: "commented", isRequested: false }),
      reviewer({ login: "requested", state: "pending", isRequested: true }),
      reviewer({ login: "blocker", state: "changes_requested", isRequested: false }),
      reviewer({ login: "old", state: "dismissed", isRequested: false }),
    ]);
    const order = ["requested", "blocker", "approver", "commenter", "old"].map((login) =>
      html.indexOf(login),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("sorts alphabetically within a state bucket", async () => {
    const html = await render([
      reviewer({ login: "zoe", state: "approved", isRequested: false }),
      reviewer({ login: "alice", state: "approved", isRequested: false }),
    ]);
    expect(html.indexOf("alice")).toBeLessThan(html.indexOf("zoe"));
  });
});
