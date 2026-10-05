/**
 * The `test` every demo flow uses. It opens the app against the demo stack
 * and hands the flow a `demo` object whose actions look good on video: the
 * cursor glides to its target, clicks ripple, and text is typed a key at a
 * time.
 *
 * Each flow's screenshots and video land in `demo/output/<flow-title>/`, the
 * title lowercased and hyphenated.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import type { Alarm } from "../src/lib/alarms";
import { type DemoConfig, UNMOCKED_COMMAND_WARNING } from "./demoConfig";
import { FAKE_MODEL } from "./fakeLlm/server";
import { flowOutputDir, slugify } from "./paths";
import { DEMO_GOOGLE_CLIENT_ID, FAKE_PROVIDER_ID, PASSTHROUGH_SECRETS } from "./stack";

export const VIEWPORT = { width: 1440, height: 900 };

/** Matches `SETUP_GUIDE_SEEN_KEY` in `src/lib/onboarding.ts`. */
const SETUP_GUIDE_SEEN_KEY = "yarvis.setupGuide.seen";

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
    // About one step per 12px, and at least 8, so long moves glide rather than jump.
    await this.page.mouse.move(x, y, { steps: Math.max(8, Math.round(distance / 12)) });
    this.mouse = { x, y };
  }

  async click(target: Locator): Promise<void> {
    await this.hover(target);
    await this.pause(150);
    // Clicks at the point the cursor already rests on, after Playwright's
    // checks that the element is enabled and not covered.
    await target.click();
    await this.pause(400);
  }

  /** Clicks into `target` and types `text` at a readable speed. */
  async type(target: Locator, text: string, { delay = 45 } = {}): Promise<void> {
    await this.click(target);
    await target.pressSequentially(text, { delay });
    await this.pause(300);
  }

  /** Opens a nav rail tab by its label ("Tasks", "Memory", "Settings"). */
  async openTab(label: string): Promise<void> {
    // A tab with a badge appends a hint to its accessible name ("PRs — 2 need review").
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = new RegExp(`^${escaped}( —|$)`);
    await this.click(this.page.getByRole("navigation").getByRole("button", { name }));
    await this.pause(600);
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.pause(400);
  }

  /** Rings an alarm, raising the full-screen takeover. */
  async fireAlarm(alarm: Omit<Alarm, "status">): Promise<void> {
    await this.page.evaluate((a) => {
      const controls = window.__yarvisDemoControls;
      if (!controls) throw new Error("the Tauri mock isn't installed");
      return controls.fireAlarm(a);
    }, alarm);
  }

  /** Fires a native event, as the Rust core would (e.g. `omni-chat-summon`). */
  async emit(event: string, payload?: unknown): Promise<void> {
    await this.page.evaluate(
      ({ event, payload }) => {
        const controls = window.__yarvisDemoControls;
        if (!controls) throw new Error("the Tauri mock isn't installed");
        return controls.emit(event, payload);
      },
      { event, payload },
    );
  }

  /**
   * Saves a numbered screenshot, `01-<name>.png`, of the page or of one
   * element. Waits a beat first so animations settle. The fake cursor is left
   * out unless `cursor` is set.
   */
  async shot(
    name: string,
    { target, cursor = false }: { target?: Locator; cursor?: boolean } = {},
  ): Promise<string> {
    await this.pause(300);
    this.shotCount += 1;
    const file = join(
      this.outputDir,
      `${String(this.shotCount).padStart(2, "0")}-${slugify(name)}.png`,
    );
    const style = cursor ? undefined : "#demo-cursor, .demo-ripple { display: none !important; }";
    await (target ?? this.page).screenshot({ path: file, animations: "disabled", style });
    return file;
  }
}

export const test = base.extend<{ demo: Demo }>({
  page: async ({ page }, use) => {
    const demoConfig: DemoConfig = {
      sidecarPort: Number(process.env.DEMO_SIDECAR_PORT),
      sidecarToken: process.env.DEMO_SIDECAR_TOKEN ?? "",
      googleClientId: DEMO_GOOGLE_CLIENT_ID,
      // Settings shows a key as stored exactly when the sidecar was given it.
      presentSecrets: [
        "database_url",
        // The sidecar is given placeholder values for these, for the fake GitHub and Google.
        "github_token",
        "google_client_secret",
        ...PASSTHROUGH_SECRETS.filter((key) => process.env[key]).map((key) => key.toLowerCase()),
      ],
    };
    await page.addInitScript(
      ({ config, setupGuideKey, provider, model }) => {
        window.__YARVIS_DEMO_CONFIG__ = config;
        // Skip the first-run setup guide, which would cover every screen.
        localStorage.setItem(setupGuideKey, "1");
        // Every chat surface reads these (src/lib/useChatThread.ts). Without them
        // each picks the first available built-in provider instead of the fake
        // model, and Bedrock always reports itself available.
        localStorage.setItem("yarvis.chat.provider", provider);
        localStorage.setItem("yarvis.chat.model", model);
      },
      {
        config: demoConfig,
        setupGuideKey: SETUP_GUIDE_SEEN_KEY,
        provider: `custom:${FAKE_PROVIDER_ID}`,
        model: FAKE_MODEL,
      },
    );
    await page.addInitScript(installCursor);

    const unmocked: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith(UNMOCKED_COMMAND_WARNING)) unmocked.push(message.text());
    });

    await use(page);

    // The UI called something the mock doesn't answer, so a screenshot may
    // show a broken screen. Add the command to tauriMock.ts.
    expect(unmocked, "Tauri commands the demo mock doesn't answer").toEqual([]);
  },

  demo: async ({ page }, use, testInfo) => {
    const outputDir = flowOutputDir(testInfo.title);
    // Start clean, so a shot a flow no longer takes doesn't linger beside the new ones.
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });

    const appUrl = process.env.DEMO_APP_URL;
    if (!appUrl) throw new Error("DEMO_APP_URL is unset; run flows with `bun run demo`");
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
