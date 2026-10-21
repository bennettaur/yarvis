import { defineConfig } from "@playwright/test";
import { VIEWPORT } from "./fixture";

export default defineConfig({
  testDir: "./flows",
  testMatch: "*.demo.ts",
  outputDir: "./output/.playwright",
  globalSetup: "./globalSetup.ts",
  // Flows share one sidecar and database, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  // Flows pause and type at human speed, so they run well past the 30s default.
  timeout: 5 * 60_000,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: VIEWPORT,
    // Screenshots at 2x. Video is recorded at the viewport size regardless.
    deviceScaleFactor: 2,
    colorScheme: "dark",
    video: { mode: "on", size: VIEWPORT },
    trace: "retain-on-failure",
    // A selector that matches nothing fails here rather than at the 5-minute test timeout.
    actionTimeout: 15_000,
  },
});
