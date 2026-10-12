/**
 * Turns a `bun run demo` run into a static site for GitHub Pages: an index
 * with each flow's video and screenshots, plus the showcase deck at
 * `showcase/` and, when it has been built, the showcase video's player at
 * `video/`. Reads `demo/output/` and `video/dist/`, writes `demo/site/`.
 *
 *   bun run demo && bun run --cwd video player:build && bun run demo:site
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OUTPUT_DIR, REPO_ROOT } from "./paths";

export const SITE_DIR = join(REPO_ROOT, "demo", "site");
const SHOWCASE = join(REPO_ROOT, "docs", "showcase", "yarvis-showcase.html");
/** The showcase video's web player, as `bun run --cwd video player:build` leaves it. */
const VIDEO_PLAYER = join(REPO_ROOT, "video", "dist");

/**
 * How each flow is introduced on the page, keyed by its output directory. The
 * page lists flows in this order; one missing here goes last, titled from its
 * directory name.
 */
const FLOW_INTROS: Record<string, { title: string; blurb: string }> = {
  tour: {
    title: "A quick tour",
    blurb: "Tasks, memory and the dashboard, then an alarm going off.",
  },
  chat: {
    title: "Chat",
    blurb: "Ask about the week, then have the assistant add a task, which lands on the Tasks list.",
  },
  "omni-chat": {
    title: "Omni Chat",
    blurb: "Summon the assistant over any screen and ask about what's on it.",
  },
  "omni-builder": {
    title: "Omni layouts",
    blurb: "Describe a dashboard and watch it assemble from live widgets.",
  },
  github: {
    title: "Pull requests and issues",
    blurb: "Your PRs, the reviews waiting on you, and issues.",
  },
  calendar: { title: "Calendar", blurb: "The week ahead, with an alarm armed for a meeting." },
  terminal: { title: "Terminal", blurb: "Shells inside the app, next to everything else." },
  "workspace-agent": {
    title: "Workspaces",
    blurb: "A workspace with a Claude Code session working through a change.",
  },
};

export interface Flow {
  slug: string;
  screenshots: string[];
  hasVideo: boolean;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A path inside the site, safe to put in an HTML attribute. */
function sitePath(...parts: string[]): string {
  return escapeHtml(parts.map(encodeURIComponent).join("/"));
}

/**
 * Names the demo harness writes: slugified flow titles and numbered
 * screenshots. Anything else in the output directory is left off the page.
 */
const FLOW_NAME = /^[a-z0-9-]+$/;
const SHOT_NAME = /^[a-z0-9-]+\.png$/;

/** "02-task-added.png" becomes "Task added". */
function captionFor(file: string): string {
  const words = file
    .replace(/^\d+-/, "")
    .replace(/\.png$/, "")
    .replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The flows a run produced, in the order the page shows them. */
export function readFlows(outputDir: string): Flow[] {
  if (!existsSync(outputDir)) return [];
  const order = Object.keys(FLOW_INTROS);
  const rank = (slug: string) => {
    const i = order.indexOf(slug);
    return i === -1 ? order.length : i;
  };
  return (
    readdirSync(outputDir, { withFileTypes: true })
      // `.state` and `.playwright` are the run's scratch space, not flows.
      .filter((entry) => entry.isDirectory() && FLOW_NAME.test(entry.name))
      .map((entry) => {
        const files = readdirSync(join(outputDir, entry.name));
        return {
          slug: entry.name,
          screenshots: files.filter((f) => SHOT_NAME.test(f)).sort(),
          hasVideo: files.includes("video.webm"),
        };
      })
      .filter((flow) => flow.screenshots.length > 0 || flow.hasVideo)
      .sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug))
  );
}

/** `withVideo` adds a link to the showcase video's player, for a site that includes it. */
export function renderIndex(flows: Flow[], builtFrom: string, withVideo = false): string {
  const sections = flows
    .map((flow) => {
      const intro = FLOW_INTROS[flow.slug] ?? { title: captionFor(flow.slug), blurb: "" };
      // The recording opens on a blank page before the app paints, so the
      // first screenshot stands in until it plays.
      const poster = flow.screenshots[0]
        ? ` poster="${sitePath(flow.slug, flow.screenshots[0])}"`
        : "";
      const video = flow.hasVideo
        ? `<video src="${sitePath(flow.slug, "video.webm")}"${poster} controls muted loop playsinline preload="metadata"></video>`
        : "";
      const shots = flow.screenshots
        .map(
          (file) =>
            `<figure><a href="${sitePath(flow.slug, file)}"><img src="${sitePath(flow.slug, file)}" alt="${escapeHtml(captionFor(file))}" loading="lazy"></a><figcaption>${escapeHtml(captionFor(file))}</figcaption></figure>`,
        )
        .join("\n");
      return `<section id="${escapeHtml(flow.slug)}">
<h2>${escapeHtml(intro.title)}</h2>
${intro.blurb ? `<p>${escapeHtml(intro.blurb)}</p>` : ""}
${video}
<div class="shots">${shots}</div>
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yarvis in action</title>
<style>
  :root { --bg: #09090b; --panel: #18181b; --line: #3f3f46; --text: #f4f4f5; --muted: #a1a1aa; --accent: #818cf8; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  header, main, footer { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
  header { padding-top: 48px; }
  h1 { font-size: 40px; margin: 0 0 8px; }
  h2 { margin: 56px 0 4px; }
  p { color: var(--muted); margin: 0 0 16px; }
  a { color: var(--accent); }
  nav { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0 0; }
  video { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: #000; }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; margin-top: 16px; }
  figure { margin: 0; }
  img { width: 100%; border: 1px solid var(--line); border-radius: 6px; display: block; }
  figcaption { color: var(--muted); font-size: 14px; margin-top: 6px; }
  footer { color: var(--muted); font-size: 13px; padding: 64px 24px 48px; }
</style>
</head>
<body>
<header>
<h1>Yarvis in action</h1>
<p>Recorded automatically from the real app, driven by scripted demo flows. Every name and detail in them is made up.</p>
<nav>${withVideo ? '<a href="video/">Showcase video</a>' : ""}<a href="showcase/">Showcase deck</a>${flows.map((f) => `<a href="#${escapeHtml(f.slug)}">${escapeHtml(FLOW_INTROS[f.slug]?.title ?? captionFor(f.slug))}</a>`).join("")}</nav>
</header>
<main>
${sections}
</main>
<footer>Built ${escapeHtml(builtFrom)}.</footer>
</body>
</html>
`;
}

function buildSite(): void {
  const flows = readFlows(OUTPUT_DIR);
  if (flows.length === 0)
    throw new Error(`no demo output in ${OUTPUT_DIR}; run \`bun run demo\` first`);

  rmSync(SITE_DIR, { recursive: true, force: true });
  for (const flow of flows) {
    mkdirSync(join(SITE_DIR, flow.slug), { recursive: true });
    const files = [...flow.screenshots, ...(flow.hasVideo ? ["video.webm"] : [])];
    for (const file of files) {
      copyFileSync(join(OUTPUT_DIR, flow.slug, file), join(SITE_DIR, flow.slug, file));
    }
  }
  mkdirSync(join(SITE_DIR, "showcase"), { recursive: true });
  copyFileSync(SHOWCASE, join(SITE_DIR, "showcase", "index.html"));
  const withVideo = existsSync(VIDEO_PLAYER);
  // Optional locally, but the published site is linked to at video/, so CI
  // must not quietly publish without it.
  if (!withVideo && process.env.CI)
    throw new Error(
      `no video player in ${VIDEO_PLAYER}; run \`bun run --cwd video player:build\` first`,
    );
  if (withVideo) cpSync(VIDEO_PLAYER, join(SITE_DIR, "video"), { recursive: true });

  const sha = process.env.GITHUB_SHA?.slice(0, 7);
  // en-CA formats as YYYY-MM-DD, in the run's own time zone.
  const builtFrom = `${new Date().toLocaleDateString("en-CA")}${sha ? ` from ${sha}` : ""}`;
  writeFileSync(join(SITE_DIR, "index.html"), renderIndex(flows, builtFrom, withVideo));
  console.info(
    `[demo:site] wrote ${flows.length} flows${withVideo ? " and the video player" : ""} to ${SITE_DIR}`,
  );
}

if (import.meta.main) buildSite();
