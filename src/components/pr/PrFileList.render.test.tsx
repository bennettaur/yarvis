import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { PrFile, PrRef } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";

// PrFileList reads its files through usePrFiles (a sidecar-backed resource).
// Stub the cache so each test renders against a fixed file set. mock.module is
// process-global in bun, so keep the module's other exports (usePrDetail, …)
// intact for any test file that shares the process.
let filesResource: { data: PrFile[] | null; error: string | null; loading: boolean } = {
  data: null,
  error: null,
  loading: false,
};
const actualCache = await import("../../lib/pr/cache");
mock.module("../../lib/pr/cache", () => ({
  ...actualCache,
  usePrFiles: () => filesResource,
}));

// Imported after the mock so the stub is in place.
const { default: PrFileList } = await import("./PrFileList");

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

const file = (filename: string, over: Partial<PrFile> = {}): PrFile => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: null,
  ...over,
});

const render = (
  data: PrFile[] | null,
  opts: {
    viewed?: Set<string>;
    onCollapse?: () => void;
    error?: string | null;
    loading?: boolean;
  } = {},
) => {
  filesResource = { data, error: opts.error ?? null, loading: opts.loading ?? false };
  return renderToHtml(
    createElement(PrFileList, {
      prRef,
      viewed: opts.viewed ?? new Set<string>(),
      onToggleViewed: () => {},
      onCollapse: opts.onCollapse,
    }),
  );
};

describe("PrFileList", () => {
  it("nests files under a folder row", async () => {
    const html = await render([file("src/a.ts"), file("src/b.ts")]);
    // The folder name renders once, and both basenames render as file rows.
    expect(html).toContain("src");
    expect(html).toContain("a.ts");
    expect(html).toContain("b.ts");
    // Rows show basenames, not the full path repeated as visible text.
    expect(html).toContain("<details");
  });

  it("shows the viewed count from the viewed set", async () => {
    const html = await render([file("a.ts"), file("b.ts")], {
      viewed: new Set(["a.ts"]),
    });
    expect(html).toContain("1/2 viewed");
  });

  it("renders the collapse button only when onCollapse is provided", async () => {
    const withCollapse = await render([file("a.ts")], { onCollapse: () => {} });
    expect(withCollapse).toContain("Collapse file list");

    const withoutCollapse = await render([file("a.ts")]);
    expect(withoutCollapse).not.toContain("Collapse file list");
  });

  // Rows only show a basename, so the copy button has to carry the full path.
  it("offers a copy button holding each file's full path", async () => {
    const html = await render([file("src/deep/a.ts")]);
    expect(html).toContain("Copy path src/deep/a.ts");
  });

  it("falls back to a bullet for an unknown status", async () => {
    const html = await render([file("a.ts", { status: "copied" })]);
    expect(html).toContain("•");
  });

  it("renders the empty, loading, and error states", async () => {
    expect(await render([])).toContain("No file changes.");
    expect(await render(null, { loading: true })).toContain("Loading files…");
    expect(await render(null, { error: "boom" })).toContain("boom");
  });
});
