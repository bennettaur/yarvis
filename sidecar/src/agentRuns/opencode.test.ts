import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  jsonAnswer,
  makeOpenCodeDirs,
  OpenCodeEventParser,
  openCodeActions,
  openCodeCommand,
  openCodeConfig,
  openCodeEnv,
  openCodeSandboxProfile,
  removeOpenCodeDirs,
  SANDBOX_EXEC,
} from "./opencode.ts";
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

  it("skips lines it can't read", () => {
    const parser = new OpenCodeEventParser("/checkout");
    expect(parser.parseLine("not json").events).toEqual([]);
    expect(parser.parseLine(JSON.stringify({ type: "something-new" })).events).toEqual([]);
  });
});

describe("the answer in a model's last message", () => {
  it("takes the whole message, or the object inside a fence or a sentence", () => {
    expect(jsonAnswer('{"a": 1}')).toEqual({ a: 1 });
    expect(jsonAnswer('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(jsonAnswer('Here it is: {"a": {"b": 2}} Done.')).toEqual({ a: { b: 2 } });
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

  it("points every OpenCode folder into the process's own and hands it the catalog", () => {
    const dirs = makeOpenCodeDirs(makeTempDir("yarvis-opencode-test-"));
    try {
      expect(openCodeEnv(dirs, "/x/models.json")).toEqual({
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_STATE_HOME: dirs.state,
        XDG_CACHE_HOME: dirs.cache,
        TMPDIR: dirs.tmp,
        OPENCODE_MODELS_PATH: "/x/models.json",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
      });
      expect(openCodeEnv(dirs, null)).not.toHaveProperty("OPENCODE_MODELS_PATH");
    } finally {
      removeOpenCodeDirs(dirs);
    }
    expect(existsSync(dirs.root)).toBe(false);
  });

  it("runs OpenCode standalone under the sandbox, with the task as its message", () => {
    const command = openCodeCommand({
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
      openCodeCommand({ program: "x", profile: "", agentId: "a", model: "a/b", prompt: "--help" }),
    ).toThrow("can't start with -");
  });

  it("denies the user's OpenCode folders and credentials, and writes outside its own folder", () => {
    const profile = openCodeSandboxProfile({
      root: "/private/tmp/run",
      secretPaths: [".ssh"],
      home: "/Users/someone",
    });
    expect(profile).toContain('(subpath "/Users/someone/.ssh")');
    expect(profile).toContain('(subpath "/Users/someone/.local/share/opencode")');
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp/run")');
  });

  it.skipIf(!existsSync(SANDBOX_EXEC))(
    "holds under the real sandbox-exec: writes only inside its folder, no reads of a secret",
    () => {
      const home = makeTempDir("yarvis-opencode-home-");
      writeFileSync(join(home, "secret"), "x");
      const dirs = makeOpenCodeDirs(makeTempDir("yarvis-opencode-test-"));
      const outside = makeTempDir("yarvis-opencode-outside-");
      try {
        const profile = openCodeSandboxProfile({ root: dirs.root, secretPaths: ["secret"], home });
        const run = (script: string) =>
          spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script]).status;
        expect(run(`echo ok > "${dirs.tmp}/inside"`)).toBe(0);
        expect(run(`echo no > "${outside}/x"`)).not.toBe(0);
        expect(run(`cat "${home}/secret"`)).not.toBe(0);
      } finally {
        removeOpenCodeDirs(dirs);
      }
    },
  );
});
