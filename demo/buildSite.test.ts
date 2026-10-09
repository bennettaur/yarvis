import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFlows, renderIndex } from "./buildSite";

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
  it("captions screenshots from their file names and links the deck", () => {
    const html = renderIndex(
      [{ slug: "chat", screenshots: ["01-week-summary.png"], hasVideo: true }],
      "2026-10-05",
    );
    expect(html).toContain("<figcaption>Week summary</figcaption>");
    expect(html).toContain('src="chat/video.webm"');
    expect(html).toContain('href="showcase/"');
    expect(html).not.toContain('href="video/"');
  });

  it("links the showcase video's player when the site includes it", () => {
    const html = renderIndex([], "2026-10-05", true);
    expect(html).toContain('href="video/"');
  });
});
