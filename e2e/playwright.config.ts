import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  outputDir: "./output",
  // Each spec starts its own server, but the steps inside one build on each other.
  workers: 1,
  fullyParallel: false,
  timeout: 3 * 60_000,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
  },
});
