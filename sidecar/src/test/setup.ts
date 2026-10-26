import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetViewerLogins } from "../github/client.ts";
import { resetRateLimits } from "../github/rateLimit.ts";

// Keep the whole suite off the user's ~/.yarvis, so a test that forgets its own
// override can't write their settings.json or load their agent definitions.
const dir = mkdtempSync(join(tmpdir(), "yarvis-sidecar-test-"));
process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
process.env.YARVIS_AGENTS_DIR = join(dir, "agents");
// A top-level afterAll in a preload runs once, after every test file.
// process.on("exit") never fires under bun test.
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// GitHub rate limits and logins are remembered per token for the life of the
// process, and test files reuse tokens, so one test's 429 or login would
// otherwise leak into the next.
beforeEach(() => {
  resetRateLimits();
  resetViewerLogins();
});
