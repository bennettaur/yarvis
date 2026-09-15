import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail, PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import { prFile as file, setPrFiles } from "../../test/prFiles";
import { mountForInteraction, renderToHtml } from "../../test/render";
import { FLASH_ATTR } from "./flashFile";
import { prFileAnchorId } from "./shared";

// Imported after the shared stub so its usePrFiles mock is in place.
const { default: PrFileList } = await import("./PrFileList");

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

const render = (
  data: PrFile[] | null,
  opts: {
    viewed?: Set<string>;
    onCollapse?: () => void;
    error?: string | null;
    loading?: boolean;
  } = {},
) => {
  setPrFiles(data, { error: opts.error, loading: opts.loading });
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
    expect(html).toContain("<details");
    expect(html).toContain(">src</span>");
    // Rows show basenames, not the full path repeated as visible text (the
    // paths still reach the copy button and the row's title attribute).
    expect(html).not.toContain(">src/a.ts<");
    expect(html).not.toContain(">src/b.ts<");
    expect(html).toContain(">a.ts<");
    expect(html).toContain(">b.ts<");
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

describe("PrFileList comment counts", () => {
  const thread = (
    path: string | null,
    commentCount: number,
    { isResolved = false, line = 1 as number | null } = {},
  ): ReviewThread => ({
    path,
    line,
    isResolved,
    comments: Array.from({ length: commentCount }, () => ({
      author: "octocat",
      body: "hm",
      createdAt: "2026-01-01T00:00:00Z",
    })),
  });

  const detail = (overrides: Partial<PrDetail> = {}): PrDetail => ({
    number: 1,
    title: "Add a thing",
    body: "",
    state: "open",
    draft: false,
    author: "me",
    baseRef: "main",
    headRef: "feat",
    fromFork: false,
    headSha: "",
    additions: 0,
    deletions: 0,
    mergeable: "MERGEABLE",
    mergeMethods: [],
    autoMergeEnabled: false,
    canEnableAutoMerge: false,
    canDisableAutoMerge: false,
    checks: [],
    reviewThreads: [],
    reviewers: [],
    ...overrides,
  });

  const primeThreads = (reviewThreads: ReviewThread[]) =>
    primeCache(prDetailKey(prRef), detail({ reviewThreads }));

  /** The comment label on one file's row, or null when that row shows no count. */
  const countOnRow = (html: string, path: string) => {
    const row = html.split("<li").find((segment) => segment.includes(`title="${path}"`));
    return row?.match(/aria-label="(\d+ comments?)"/)?.[1] ?? null;
  };

  it("totals every comment on a file across its threads, resolved ones included", async () => {
    primeThreads([
      thread("src/a.ts", 2),
      thread("src/a.ts", 1, { isResolved: true }),
      thread("b.ts", 1),
    ]);
    const html = await render([file("src/a.ts"), file("b.ts")]);
    expect(countOnRow(html, "src/a.ts")).toBe("3 comments");
    expect(countOnRow(html, "b.ts")).toBe("1 comment");
  });

  it("ignores threads the diff can't anchor: no path, or no line", async () => {
    primeThreads([
      thread("src/a.ts", 2),
      thread(null, 4),
      thread("src/a.ts", 5, { line: null }),
      thread("b.ts", 3, { line: null }),
    ]);
    const html = await render([file("src/a.ts"), file("b.ts")]);
    expect(countOnRow(html, "src/a.ts")).toBe("2 comments");
    expect(countOnRow(html, "b.ts")).toBeNull();
  });
});

describe("PrFileList jump", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    document.getElementById(prFileAnchorId(prRef, "src/deep/a.ts"))?.remove();
  });

  it("flashes the diff it scrolled to", async () => {
    const diff = document.createElement("details");
    diff.id = prFileAnchorId(prRef, "src/deep/a.ts");
    diff.innerHTML = "<summary>src/deep/a.ts</summary>";
    document.body.appendChild(diff);

    setPrFiles([file("src/deep/a.ts")]);
    const mounted = await mountForInteraction(
      createElement(PrFileList, {
        prRef,
        viewed: new Set<string>(),
        onToggleViewed: () => {},
      }),
    );
    cleanup = mounted.unmount;

    // Matched on the exact title: the row's copy button carries the same path
    // inside a longer one.
    const row = [...mounted.host.querySelectorAll("button")].find(
      (b) => b.title === "src/deep/a.ts",
    );
    expect(row).toBeDefined();
    row?.click();

    expect(diff.querySelector("summary")?.hasAttribute(FLASH_ATTR)).toBe(true);
  });
});
