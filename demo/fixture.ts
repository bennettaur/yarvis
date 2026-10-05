/**
 * The `test` every demo flow uses. It opens the app against the demo stack
 * and hands the flow a `demo` object whose actions look good on video: the
 * cursor glides to its target, clicks ripple, and text is typed a key at a
 * time.
 *
 * Each flow's screenshots and video land in `demo/output/<flow title>/`.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import type { Alarm } from "../src/lib/alarms";
import type { DemoConfig } from "./tauriMock";

export const VIEWPORT = { width: 1440, height: 900 };

const OUTPUT_DIR = join(import.meta.dirname, "output");

/**
 * Draws a cursor and click ripples, since Playwright's video shows neither.
 * Runs in the page before the app loads.
 */
function installCursor() {
  const style = document.createElement("style");
  style.textContent = `
    #demo-cursor {
      position: fixed; z-index: 2147483647; pointer-events: none;
      width: 22px; height: 22px; margin: -2px 0 0 -2px;
      background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M3 2l7 19 2.5-7.5L20 11z' fill='white' stroke='black' stroke-width='1.5' stroke-linejoin='round'/></svg>") no-repeat;
      transition: transform 60ms;
    }
    #demo-cursor.down { transform: scale(0.85); }
    .demo-ripple {
      position: fixed; z-index: 2147483646; pointer-events: none;
      width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%;
      border: 2px solid rgba(129, 140, 248, 0.9);
      animation: demo-ripple 500ms ease-out forwards;
    }
    @keyframes demo-ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
  `;
  const cursor = document.createElement("div");
  cursor.id = "demo-cursor";
  cursor.style.left = "-100px";
  window.addEventListener("DOMContentLoaded", () => {
    document.head.append(style);
    document.body.append(cursor);
  });
  window.addEventListener(
    "mousemove",
    (e) => {
      cursor.style.left = `${e.clientX}px`;
      cursor.style.top = `${e.clientY}px`;
    },
    true,
  );
  window.addEventListener(
    "mousedown",
    (e) => {
      cursor.classList.add("down");
      const ripple = document.createElement("div");
      ripple.className = "demo-ripple";
      ripple.style.left = `${e.clientX}px`;
      ripple.style.top = `${e.clientY}px`;
      document.body.append(ripple);
      setTimeout(() => ripple.remove(), 600);
    },
    true,
  );
  window.addEventListener("mouseup", () => cursor.classList.remove("down"), true);
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class Demo {
  private shotCount = 0;
  private mouse = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

  constructor(
    readonly page: Page,
    readonly outputDir: string,
  ) {}

  /** Waits, so the viewer has time to take in what just happened. */
  async pause(ms = 800): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** Glides the cursor to the middle of `target`. */
  async hover(target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`cannot move to ${target}: it has no bounding box`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const distance = Math.hypot(x - this.mouse.x, y - this.mouse.y);
    await this.page.mouse.move(x, y, { steps: Math.max(8, Math.round(distance / 12)) });
    this.mouse = { x, y };
  }

  async click(target: Locator): Promise<void> {
    await this.hover(target);
    await this.pause(150);
    await this.page.mouse.down();
    await this.page.mouse.up();
    await this.pause(400);
  }

  /** Clicks into `target` and types `text` at a readable speed. */
  async type(target: Locator, text: string, { delay = 45 } = {}): Promise<void> {
    await this.click(target);
    await this.page.keyboard.type(text, { delay });
    await this.pause(300);
  }

  /** Opens a nav rail tab by its label ("Tasks", "Memory", "Settings"). */
  async openTab(label: string): Promise<void> {
    // A tab with a badge appends a hint to its accessible name ("PRs — 2 need review").
    const name = new RegExp(`^${label}( —|$)`);
    await this.click(this.page.getByRole("navigation").getByRole("button", { name }));
    await this.pause(600);
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.pause(400);
  }

  /** Rings an alarm, raising the full-screen takeover. */
  async fireAlarm(alarm: Omit<Alarm, "status">): Promise<void> {
    await this.page.evaluate((a) => window.__yarvisDemo?.fireAlarm(a), alarm);
  }

  /** Fires a native event, as the Rust core would (e.g. `omni-chat-summon`). */
  async emit(event: string, payload?: unknown): Promise<void> {
    await this.page.evaluate(([e, p]) => window.__yarvisDemo?.emit(e as string, p), [
      event,
      payload,
    ] as const);
  }

  /**
   * Saves a numbered screenshot, `01-<name>.png`, of the page or of one
   * element. Waits a beat first so animations settle. The fake cursor is left
   * out unless `cursor` is set.
   */
  async shot(
    name: string,
    { target, cursor = false }: { target?: Locator; cursor?: boolean } = {},
  ) {
    await this.pause(300);
    this.shotCount += 1;
    const file = join(
      this.outputDir,
      `${String(this.shotCount).padStart(2, "0")}-${slugify(name)}.png`,
    );
    const style = cursor ? undefined : "#demo-cursor, .demo-ripple { display: none !important; }";
    if (target) await target.screenshot({ path: file, animations: "disabled", style });
    else await this.page.screenshot({ path: file, animations: "disabled", style });
    return file;
  }
}

export const test = base.extend<{ demo: Demo }>({
  page: async ({ page }, use) => {
    const demoConfig: DemoConfig = {
      sidecarPort: Number(process.env.DEMO_SIDECAR_PORT),
      sidecarToken: process.env.DEMO_SIDECAR_TOKEN ?? "",
      presentSecrets: ["database_url", "anthropic_api_key"],
    };
    await page.addInitScript((c) => {
      window.__YARVIS_DEMO__ = c;
      // Skip the first-run setup guide, which would cover every screen.
      localStorage.setItem("yarvis.setupGuide.seen", "1");
    }, demoConfig);
    await page.addInitScript(installCursor);
    await use(page);
  },

  demo: async ({ page }, use, testInfo) => {
    const outputDir = join(OUTPUT_DIR, slugify(testInfo.title));
    // Start clean, so a shot a flow no longer takes doesn't linger beside the new ones.
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });

    const appUrl = process.env.DEMO_APP_URL;
    if (!appUrl)
      throw new Error("DEMO_APP_URL is unset; run flows through demo/playwright.config.ts");
    await page.goto(appUrl);
    // BootGate holds the app behind a loading screen until the sidecar is
    // ready; the nav rail is the first thing that appears after it.
    await expect(page.getByRole("navigation").first()).toBeVisible({ timeout: 30_000 });

    await use(new Demo(page, outputDir));

    const video = page.video();
    await page.close();
    if (video) await video.saveAs(join(outputDir, "video.webm"));
  },
});

export { expect };
