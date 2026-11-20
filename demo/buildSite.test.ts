import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFlows, renderIndex } from "./buildSite";
import { REPO_ROOT } from "./paths";

describe("readFlows", () => {
  it("lists each flow's screenshots and video, skipping anything the harness didn't write", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-site-"));
    try {
      for (const [flow, files] of Object.entries({
        chat: [
          "02-task-created.png",
          "01-week-summary.png",
          "video.webm",
          'x" onerror="alert(1).png',
        ],
        tour: ["01-tasks.png"],
        ".state": ["home"],
        empty: [],
      })) {
        mkdirSync(join(dir, flow), { recursive: true });
        for (const file of files) writeFileSync(join(dir, flow, file), "");
      }
      expect(readFlows(dir)).toEqual([
        { slug: "tour", screenshots: ["01-tasks.png"], hasVideo: false },
        {
          slug: "chat",
          screenshots: ["01-week-summary.png", "02-task-created.png"],
          hasVideo: true,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderIndex", () => {
  it("captions screenshots from their file names and links the deck and the verification explainers", () => {
    const html = renderIndex(
      [{ slug: "chat", screenshots: ["01-week-summary.png"], hasVideo: true }],
      "2026-10-05",
    );
    expect(html).toContain("<figcaption>Week summary</figcaption>");
    expect(html).toContain('src="chat/video.webm"');
    expect(html).toContain('href="showcase/"');
    expect(html).toContain('href="verification/verify-pr-explainer.html"');
    expect(html).toContain('href="verification/verification-report-explainer.html"');
    expect(html).not.toContain('href="video/"');
  });

  it("links the showcase video's player when the site includes it", () => {
    const html = renderIndex([], "2026-10-05", true);
    expect(html).toContain('href="video/"');
  });

  // The Demo site workflow doesn't run on a PR that only touches docs/, so a
  // renamed explainer would otherwise first fail on the next scheduled publish.
  it("links only verification pages that exist in docs/", () => {
    const html = renderIndex([], "2026-10-05");
    const pages = [...html.matchAll(/href="verification\/([^"]+)"/g)].map((m) => m[1]);
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(existsSync(join(REPO_ROOT, "docs", page))).toBe(true);
  });
});
