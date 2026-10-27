import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProgram, programOf, validateWorkingDir } from "./claudeCli.ts";

// The program is read from `~/.yarvis/settings.json`; point the suite at a
// temporary one so it neither reads nor depends on the developer's own.
let settingsDir: string;
const previousSettingsPath = process.env.YARVIS_SETTINGS_PATH;

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), "yarvis-claude-cli-settings-"));
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(() => {
  if (previousSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = previousSettingsPath;
  rmSync(settingsDir, { recursive: true, force: true });
});

/** Writes an `agentCommand` into the suite's temporary settings file. */
function writeAgentCommand(command: string): void {
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ agentCommand: command }));
}

describe("resolving the program to launch", () => {
  it("takes only the program from a configured command line", () => {
    expect(programOf("/opt/claude --dangerously-skip-permissions")).toBe("/opt/claude");
  });

  it("has no program for a blank or control-character setting", () => {
    expect(programOf("   ")).toBeNull();
    expect(programOf("cla\u0003ude")).toBeNull();
  });
});

describe("the working directory", () => {
  it("accepts an existing absolute directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "yarvis-job-cwd-"));
    try {
      expect(validateWorkingDir(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a relative path", () => {
    expect(() => validateWorkingDir("repo/src")).toThrow("absolute path");
  });

  it("refuses a directory that isn't there", () => {
    expect(() => validateWorkingDir("/definitely/not/here")).toThrow("no such directory");
  });
});

describe("the program a job launches", () => {
  it("falls back to claude when nothing is configured", async () => {
    expect(await claudeProgram()).toBe("claude");
  });

  it("takes the configured build, without the flags meant for a terminal", async () => {
    writeAgentCommand("/opt/claude-next --permission-mode auto");
    expect(await claudeProgram()).toBe("/opt/claude-next");
  });
});
