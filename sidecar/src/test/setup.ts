import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the whole suite at a throwaway settings file, so a test that forgets
// its own override writes there instead of the user's ~/.yarvis/settings.json.
const dir = mkdtempSync(join(tmpdir(), "yarvis-sidecar-test-settings-"));
process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");

// A top-level afterAll in a preload runs once, after every test file.
// process.on("exit") never fires under bun test.
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
