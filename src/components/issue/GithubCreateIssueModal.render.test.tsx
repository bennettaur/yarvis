import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { IssueRepo } from "../../lib/issues/types";
import { renderToHtml } from "../../test/render";
import GithubCreateIssueModal from "./GithubCreateIssueModal";

const repos: IssueRepo[] = [
  { id: "r1", owner: "octo", repo: "web", name: "web" },
  { id: "r2", owner: "octo", repo: "api", name: "api" },
];

const render = (rows: IssueRepo[]) =>
  renderToHtml(
    createElement(GithubCreateIssueModal, {
      repos: rows,
      onClose: () => {},
      onCreated: () => {},
    }),
  );

describe("GithubCreateIssueModal", () => {
  it("offers every repo configured to pull issues", async () => {
    const html = await render(repos);
    expect(html).toContain("octo/web");
    expect(html).toContain("octo/api");
  });

  it("disables Create until a title is typed", async () => {
    const html = await render(repos);
    // The submit button is the only disabled control on first render.
    expect(html).toContain("disabled");
    expect(html).toContain("Create");
  });

  it("says so when no repo pulls issues", async () => {
    const html = await render([]);
    expect(html).toContain("No repos pull issues");
  });
});
