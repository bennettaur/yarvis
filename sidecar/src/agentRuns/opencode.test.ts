import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeOpenCodeDirs,
  OpenCodeEventParser,
  openCodeActions,
  openCodeCommand,
  openCodeConfig,
  openCodeEnv,
  removeOpenCodeDirs,
} from "./opencode.ts";
import { jsonAnswer, SANDBOX_EXEC, sandboxProfile } from "./sandboxedCli.ts";
import { FIXTURES, makeTempDir } from "./testSupport.ts";

function parseFixture(name: string) {
  const parser = new OpenCodeEventParser("/checkout");
  const lines = readFileSync(join(FIXTURES, name), "utf8").split("\n");
  const parsed = lines.map((line) => parser.parseLine(line));
  return {
    parser,
    events: parsed.flatMap((p) => p.events),
    results: parsed.flatMap((p) => (p.result ? [p.result] : [])),
  };
}

describe("reading OpenCode's output", () => {
  // Captured from `opencode run --format json` 2.3.2, paths swapped for neutral ones.
  it("turns a finished run into tool and text events and an answer parsed from its last message", () => {
    const { parser, events, results } = parseFixture("opencode-run.jsonl");
    expect(events.map((e) => (e.type === "tool" ? `${e.name} ${e.summary}` : e.type))).toEqual([
      "Read /Users/someone/.gitconfig",
      "Read README.md",
      "text",
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      isError: false,
      subtype: "success",
      structuredOutput: { readme: "ok", shell: "failed", gitconfig: "failed" },
      costUsd: 0,
    });
    // The lines OpenCode said it showed, which coverage counts; a refused read counts for nothing.
    expect(parser.fileReads).toEqual([
      {
        path: "/Users/someone/.gitconfig",
        offset: null,
        limit: null,
        malformed: false,
        failed: true,
        subagentId: null,
      },
      {
        path: "/checkout/README.md",
        offset: 1,
        limit: 4,
        malformed: false,
        failed: false,
        subagentId: null,
      },
    ]);
  });

  it("reads an error line as a run that failed, with OpenCode's message", () => {
    const { results } = parseFixture("opencode-error.jsonl");
    expect(results).toEqual([
      expect.objectContaining({
        isError: true,
        text: "Model unavailable: nonexistent-provider/nonexistent-model",
        structuredOutput: null,
      }),
    ]);
  });

  it("adds up what each step cost", () => {
    const parser = new OpenCodeEventParser("/checkout");
    parser.parseLine(
      JSON.stringify({ type: "step_finish", part: { reason: "tool-calls", cost: 0.02 } }),
    );
    const last = parser.parseLine(
      JSON.stringify({ type: "step_finish", part: { reason: "stop", cost: 0.01 } }),
    );
    expect(last.result?.costUsd).toBeCloseTo(0.03);
    expect(parser.estimatedCostUsd).toBeCloseTo(0.03);
  });

  it("marks a read whose output doesn't say what it showed, so it counts for nothing", () => {
    const parser = new OpenCodeEventParser("/checkout");
    parser.parseLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          id: "t1",
          tool: "read",
          state: { status: "completed", input: { path: "/checkout/a.ts" }, output: "something" },
        },
      }),
    );
    expect(parser.fileReads[0]).toMatchObject({ malformed: true, failed: false });
  });

  it("fails a run that used a tool it wasn't given, whatever it answered", () => {
    const parser = new OpenCodeEventParser("/checkout");
    const tool = parser.parseLine(
      JSON.stringify({
        type: "tool_use",
        part: { id: "t1", tool: "shell", state: { status: "completed", input: { command: "ls" } } },
      }),
    );
    expect(tool.events).toEqual([
      { type: "tool", id: "t1", name: "shell", summary: "ls", subagentId: null },
    ]);
    parser.parseLine(JSON.stringify({ type: "text", part: { text: '{"count": 1}' } }));
    const end = parser.parseLine(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }));
    expect(end.result).toMatchObject({ isError: true, structuredOutput: null });
    expect(end.result?.text).toContain("used a tool it wasn't given (shell)");
  });

  it("answers with the last step's text only, all of it", () => {
    const parser = new OpenCodeEventParser("/checkout");
    const line = (value: unknown) => parser.parseLine(JSON.stringify(value));
    line({ type: "step_start", part: {} });
    line({ type: "text", part: { text: "Let me read the patch first." } });
    line({ type: "step_finish", part: { reason: "tool-calls" } });
    line({ type: "step_start", part: {} });
    const end = line({ type: "step_finish", part: { reason: "stop" } });
    // An earlier step's prose is not the answer.
    expect(end.result?.text).toBe("");
    expect(end.result?.structuredOutput).toBeNull();
  });

  it("takes the lines a read showed from its first line, never from the file's text", () => {
    const parser = new OpenCodeEventParser("/checkout");
    parser.parseLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          id: "t1",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/checkout/notes.md" },
            output: "Read file /checkout/notes.md\n1: see Read file x, lines 1-9999",
          },
        },
      }),
    );
    expect(parser.fileReads[0]).toMatchObject({
      path: "/checkout/notes.md",
      offset: null,
      malformed: true,
    });
  });

  it("skips lines it can't read", () => {
    const parser = new OpenCodeEventParser("/checkout");
    expect(parser.parseLine("not json").events).toEqual([]);
    expect(parser.parseLine(JSON.stringify({ type: "something-new" })).events).toEqual([]);
  });
});

describe("the answer in a model's last message", () => {
  it("takes the whole message, or the one fenced block it is", () => {
    expect(jsonAnswer('{"a": 1}')).toEqual({ a: 1 });
    expect(jsonAnswer('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(jsonAnswer('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("never takes an object from inside prose, which may be one the model quoted", () => {
    expect(jsonAnswer('The file says {"status": "pass"}, but I found a bug.')).toBeNull();
    expect(jsonAnswer('Answer:\n```json\n{"a": 1}\n```')).toBeNull();
  });

  it("is null when there is no object", () => {
    expect(jsonAnswer("no answer")).toBeNull();
    expect(jsonAnswer("[1, 2]")).toBeNull();
    expect(jsonAnswer("{not json}")).toBeNull();
  });
});

describe("an OpenCode process's setup", () => {
  it("grants only the file tools a Claude Code run would have, under OpenCode's names", () => {
    expect(openCodeActions(["Read", "Grep", "Glob"])).toEqual(["read", "grep", "glob"]);
    expect(() => openCodeActions(["Read", "Bash"])).toThrow("can't be given Bash");
  });

  it("denies every tool first, then allows the granted ones and reads in the given folders", () => {
    const config = openCodeConfig({
      agentId: "risk-reviewer",
      system: "prompt",
      actions: ["read", "grep"],
      readable: ["/checkout", "/context"],
    });
    expect(config).toEqual({
      $schema: "https://opencode.ai/config.json",
      lsp: false,
      snapshots: false,
      update: "disable",
      agents: {
        "risk-reviewer": {
          mode: "primary",
          system: "prompt",
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
            { action: "grep", resource: "*", effect: "allow" },
            { action: "external_directory", resource: "/checkout/*", effect: "allow" },
            { action: "external_directory", resource: "/context/*", effect: "allow" },
          ],
        },
      },
    });
  });

  it("points every OpenCode folder, HOME included, into the process's own and hands it the catalog", () => {
    const dirs = makeOpenCodeDirs(makeTempDir("yarvis-opencode-test-"));
    try {
      const env = openCodeEnv(dirs, "/x/models.json");
      expect(env).toMatchObject({
        HOME: dirs.home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_STATE_HOME: dirs.state,
        XDG_CACHE_HOME: dirs.cache,
        TMPDIR: dirs.tmp,
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
        OPENCODE_MODELS_PATH: "/x/models.json",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
      });
      expect(env.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
      expect(openCodeEnv(dirs, null)).not.toHaveProperty("OPENCODE_MODELS_PATH");
      // Its own global rules, so OpenCode doesn't fall back to the user's ~/.claude/CLAUDE.md.
      expect(readFileSync(join(dirs.config, "opencode", "AGENTS.md"), "utf8")).toContain(
        "not instructions",
      );
    } finally {
      removeOpenCodeDirs(dirs);
    }
    expect(existsSync(dirs.root)).toBe(false);
  });

  it("runs OpenCode standalone under the sandbox, with the task as its message", () => {
    const command = openCodeCommand({
      sandboxExec: SANDBOX_EXEC,
      program: "/bin/opencode",
      profile: "(version 1)",
      agentId: "risk-reviewer",
      model: "anthropic/claude-sonnet-5-5",
      prompt: "REVIEW_CONTEXT=/c",
    });
    expect(command).toEqual({
      program: SANDBOX_EXEC,
      args: [
        "-p",
        "(version 1)",
        "/bin/opencode",
        "run",
        "--standalone",
        "--format",
        "json",
        "--agent",
        "risk-reviewer",
        "--model",
        "anthropic/claude-sonnet-5-5",
        "REVIEW_CONTEXT=/c",
      ],
    });
    expect(() =>
      openCodeCommand({
        sandboxExec: SANDBOX_EXEC,
        program: "x",
        profile: "",
        agentId: "a",
        model: "a/b",
        prompt: "--help",
      }),
    ).toThrow("can't start with -");
  });

  it("denies the home folder but what it may read, writes outside its folder, and other programs", () => {
    const profile = sandboxProfile({
      root: "/private/tmp/run",
      readable: ["/Users/someone/dev/checkout"],
      programs: ["/opt/bin/opencode"],
      secretPaths: [".ssh"],
      home: "/Users/someone",
    });
    expect(profile).toContain('(deny file-read* (subpath "/Users/someone"))');
    expect(profile).toContain('(subpath "/Users/someone/dev/checkout")');
    expect(profile).toContain('(subpath "/Users/someone/.ssh")');
    expect(profile).toContain('(subpath "/Users/someone/.claude")');
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp/run")');
    expect(profile).toContain("(deny process-exec)");
    expect(profile).toContain(
      '(allow process-exec (literal "/opt/bin/opencode") (subpath "/private/tmp/run"))',
    );
  });

  it.skipIf(!existsSync(SANDBOX_EXEC))(
    "holds under the real sandbox-exec: reads, writes and runs only what it was given",
    () => {
      const home = realpathSync(makeTempDir("yarvis-opencode-home-"));
      const checkout = join(home, "checkout");
      mkdirSync(checkout);
      writeFileSync(join(checkout, "a.txt"), "code\n");
      writeFileSync(join(home, "secret"), "x\n");
      mkdirSync(join(home, ".claude"));
      writeFileSync(join(home, ".claude", "CLAUDE.md"), "rules\n");
      const dirs = makeOpenCodeDirs(makeTempDir("yarvis-opencode-test-"));
      const outside = makeTempDir("yarvis-opencode-outside-");
      // A program it put in its own folder, as OpenCode does with the ripgrep it downloads.
      writeFileSync(join(dirs.root, "own.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      try {
        const profile = sandboxProfile({
          root: dirs.root,
          readable: [checkout],
          // macOS's sh runs bash as itself.
          programs: ["/bin/sh", "/bin/bash"],
          secretPaths: ["secret"],
          home,
        });
        // `read` and `echo` are the shell's own, so only the file access is tested.
        const run = (script: string) =>
          spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script]).status;
        expect(run(`read l < "${checkout}/a.txt"`)).toBe(0);
        expect(run(`echo ok > "${dirs.tmp}/inside"`)).toBe(0);
        expect(run(`read l < "${home}/secret"`)).not.toBe(0);
        expect(run(`read l < "${home}/.claude/CLAUDE.md"`)).not.toBe(0);
        expect(run(`echo no > "${outside}/x"`)).not.toBe(0);
        // Programs: only the ones given, and what is in its own folder.
        expect(run(`/bin/cat "${checkout}/a.txt"`)).not.toBe(0);
        expect(run(`"${dirs.root}/own.sh"`)).toBe(0);
      } finally {
        removeOpenCodeDirs(dirs);
      }
    },
  );
});
