import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { AgentJobTarget } from "./agentJobs.ts";
import {
  claudeProgram,
  createClaudeCodeRunner,
  parseClaudeOutput,
  programOf,
  type SpawnedRun,
  validateWorkingDir,
} from "./runners.ts";

const config = {} as Config;
const db = {} as Db;

// The program is read from `~/.yarvis/settings.json`; point the whole suite at a
// temporary one so it neither reads nor depends on the developer's own.
let settingsDir: string;
const previousSettingsPath = process.env.YARVIS_SETTINGS_PATH;

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), "yarvis-runners-settings-"));
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

function claudeTarget(cwd: string): AgentJobTarget {
  return { kind: "claude-code", cwd, model: null, permissionMode: null };
}

/** Records what the runner would have launched, and answers with `result`. */
function fakeLauncher(result: SpawnedRun) {
  const calls: { program: string; args: string[]; cwd: string }[] = [];
  const launch = async (input: { program: string; args: string[]; cwd: string }) => {
    calls.push({ program: input.program, args: input.args, cwd: input.cwd });
    return result;
  };
  return { calls, launch };
}

describe("reading the headless output", () => {
  it("takes the result field", () => {
    const parsed = parseClaudeOutput('{"result":"done","is_error":false,"session_id":"abc"}');
    expect(parsed).toEqual({ text: "done", isError: false, sessionId: "abc" });
  });

  it("keeps the raw text when the output isn't the shape we know", () => {
    expect(parseClaudeOutput("plain answer").text).toBe("plain answer");
  });

  it("reports a run that failed after reaching the model", () => {
    expect(parseClaudeOutput('{"result":"no","is_error":true}').isError).toBe(true);
  });
});

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

describe("the Claude Code runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "yarvis-job-run-"));

  it("passes the prompt as one argument and asks for JSON", async () => {
    const fake = fakeLauncher({ code: 0, stdout: '{"result":"ok"}', stderr: "" });
    const runner = createClaudeCodeRunner(fake.launch);
    const result = await runner({
      config,
      db,
      target: claudeTarget(dir),
      prompt: "check the deploy; rm -rf /",
      signal: AbortSignal.timeout(1_000),
    });
    expect(result.output).toBe("ok");
    expect(fake.calls[0].args.slice(0, 4)).toEqual([
      "-p",
      "check the deploy; rm -rf /",
      "--output-format",
      "json",
    ]);
    expect(fake.calls[0].cwd).toBe(dir);
  });

  it("denies the headless run the MCP servers and the delegation tool", async () => {
    const fake = fakeLauncher({ code: 0, stdout: '{"result":"ok"}', stderr: "" });
    await createClaudeCodeRunner(fake.launch)({
      config,
      db,
      target: claudeTarget(dir),
      prompt: "go",
      signal: AbortSignal.timeout(1_000),
    });
    expect(fake.calls[0].args).toContain("--strict-mcp-config");
    expect(fake.calls[0].args).toContain("--disallowed-tools");
    expect(fake.calls[0].args).toContain("Task");
  });

  it("adds the model and permission mode when the job sets them", async () => {
    const fake = fakeLauncher({ code: 0, stdout: '{"result":"ok"}', stderr: "" });
    const runner = createClaudeCodeRunner(fake.launch);
    await runner({
      config,
      db,
      target: { kind: "claude-code", cwd: dir, model: "sonnet", permissionMode: "acceptEdits" },
      prompt: "go",
      signal: AbortSignal.timeout(1_000),
    });
    expect(fake.calls[0].args).toContain("--model");
    expect(fake.calls[0].args).toContain("sonnet");
    expect(fake.calls[0].args).toContain("acceptEdits");
  });

  it("fails the run when the process exits non-zero", async () => {
    const fake = fakeLauncher({ code: 1, stdout: "", stderr: "not logged in" });
    const runner = createClaudeCodeRunner(fake.launch);
    await expect(
      runner({
        config,
        db,
        target: claudeTarget(dir),
        prompt: "go",
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow("not logged in");
  });

  it("fails the run when the output reports an error", async () => {
    const fake = fakeLauncher({
      code: 0,
      stdout: '{"result":"hit the turn limit","is_error":true}',
      stderr: "",
    });
    const runner = createClaudeCodeRunner(fake.launch);
    await expect(
      runner({
        config,
        db,
        target: claudeTarget(dir),
        prompt: "go",
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow("hit the turn limit");
  });

  it("refuses to start in a directory that isn't there", async () => {
    const fake = fakeLauncher({ code: 0, stdout: "{}", stderr: "" });
    const runner = createClaudeCodeRunner(fake.launch);
    await expect(
      runner({
        config,
        db,
        target: claudeTarget("/definitely/not/here"),
        prompt: "go",
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow("no such directory");
    expect(fake.calls).toHaveLength(0);
  });
});
