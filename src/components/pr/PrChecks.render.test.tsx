import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { CheckItem } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";
import { ChecksList } from "./PrChecks";

const check = (over: Partial<CheckItem> = {}): CheckItem => ({
  name: "build",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  url: null,
  ...over,
});

const render = (checks: CheckItem[], unavailable?: boolean) =>
  renderToHtml(createElement(ChecksList, { checks, unavailable }));

describe("ChecksList", () => {
  it("says there are no checks when the provider reported none", async () => {
    expect(await render([])).toContain("No checks reported.");
  });

  // "No checks reported" would read as a PR with no CI, when the token simply
  // wasn't allowed to see it.
  it("says the token can't read checks rather than that there are none", async () => {
    const html = await render([], true);
    expect(html).not.toContain("No checks reported.");
    expect(html).toContain("can't read this pull request's checks");
  });

  it("still lists the checks it could read, with a note that some are missing", async () => {
    const html = await render([check({ name: "ci/legacy" })], true);
    expect(html).toContain("ci/legacy");
    expect(html).toContain("can't read this pull request's checks");
  });
});
