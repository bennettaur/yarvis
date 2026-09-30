import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the whole suite at a throwaway settings file, so a test that forgets
// its own override writes there instead of the user's ~/.yarvis/settings.json.
const dir = mkdtempSync(join(tmpdir(), "yarvis-sidecar-test-settings-"));
process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");

process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});
