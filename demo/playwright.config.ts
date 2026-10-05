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
  timeout: 5 * 60_000,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: VIEWPORT,
    // Retina-sharp screenshots. Video is recorded at the viewport size.
    deviceScaleFactor: 2,
    colorScheme: "dark",
    video: { mode: "on", size: VIEWPORT },
    trace: "retain-on-failure",
  },
});
