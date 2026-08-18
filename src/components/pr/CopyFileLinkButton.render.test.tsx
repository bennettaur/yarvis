import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrRef } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";
import CopyFileLinkButton from "./CopyFileLinkButton";

const githubRef: PrRef = { provider: "github", owner: "octo", repo: "web", number: 7 };

const render = (props: { prRef?: PrRef; prUrl?: string; headSha?: string; path?: string } = {}) =>
  renderToHtml(
    createElement(CopyFileLinkButton, {
      prRef: props.prRef ?? githubRef,
      prUrl: props.prUrl ?? "https://github.com/octo/web/pull/7",
      headSha: props.headSha ?? "abc123",
      path: props.path ?? "src/a.ts",
    }),
  );

describe("CopyFileLinkButton", () => {
  it("names the provider and the file it copies a link to", async () => {
    const html = await render();
    expect(html).toContain("Copy the GitHub link to src/a.ts");
  });

  // Nothing here should render a button that copies a link to the wrong file.
  it("renders nothing before the head commit is known", async () => {
    expect(await render({ headSha: "" })).toBe("");
  });

  it("renders nothing when the PR URL isn't the provider's shape", async () => {
    expect(await render({ prUrl: "https://github.com/octo/web" })).toBe("");
  });
});
