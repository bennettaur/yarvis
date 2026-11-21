import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  makePiDirs,
  PiEventParser,
  piCommand,
  piEnv,
  piInstructions,
  piLaunch,
  piTools,
  removePiDirs,
} from "./pi.ts";
import { SANDBOX_EXEC, sandboxProfile } from "./sandboxedCli.ts";
import { FIXTURES, makeTempDir } from "./testSupport.ts";

const TOOLS = new Set(["read", "grep", "find", "ls"]);

function parse(lines: string[], tools: ReadonlySet<string> = TOOLS) {
  const parser = new PiEventParser("/checkout", tools);
  const parsed = lines.map((line) => parser.parseLine(line));
  return {
    parser,
    events: parsed.flatMap((p) => p.events),
    results: parsed.flatMap((p) => (p.result ? [p.result] : [])),
  };
}

const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8").split("\n");

const assistant = (text: string, stopReason: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      stopReason,
      usage: { cost: { total: 0.01 } },
      ...extra,
    },
  });
const settled = (aborted = false) => JSON.stringify({ type: "agent_settled", aborted });
const toolStart = (id: string, toolName: string, args: Record<string, unknown>) =>
  JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName, args });

describe("reading Pi's output", () => {
  // Built from the event shapes in Pi's JSON-mode docs, not captured from a real run.
  it("turns a finished run into tool and text events and an answer parsed from its last message", () => {
    const { parser, events, results } = parse(fixture("pi-run.jsonl"));
    expect(events.map((e) => (e.type === "tool" ? `${e.name} ${e.summary}` : e.type))).toEqual([
      "text",
      "Read README.md",
      "Read src/big.ts",
      "Read /Users/someone/.gitconfig",
      "text",
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      isError: false,
      subtype: "success",
      structuredOutput: { lines: 4 },
      sessionId: "0b9c1f6e-1d2a-4c55-9a3e-5f0c2d7e8a11",
    });
    expect(parser.estimatedCostUsd).toBeCloseTo(0.03);
    expect(parser.fileReads).toEqual([
      // Untruncated: the whole file, as Claude Code's default read would be.
      {
        path: "/checkout/README.md",
        offset: null,
        limit: null,
        malformed: false,
        failed: false,
        subagentId: null,
      },
      // Truncated: the lines Pi's details say it showed, not the file's own text.
      {
        path: "/checkout/src/big.ts",
        offset: 10,
        limit: 2000,
        malformed: false,
        failed: false,
        subagentId: null,
      },
      {
        path: "/Users/someone/.gitconfig",
        offset: null,
        limit: null,
        malformed: false,
        failed: true,
        subagentId: null,
      },
    ]);
  });

  it("reads a last message that stopped on an error as a failed run, with Pi's message", () => {
    const { results } = parse(fixture("pi-error.jsonl"));
    expect(results).toEqual([
      expect.objectContaining({ isError: true, text: "No API key found for anthropic" }),
    ]);
  });

  it("answers with the last message once Pi settles, so a retried turn's answer wins", () => {
    const { results } = parse([
      assistant("", "error", { errorMessage: "529 overloaded" }),
      JSON.stringify({ type: "agent_end", messages: [], willRetry: true }),
      assistant('{"a": 1}', "stop"),
      settled(),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ isError: false, structuredOutput: { a: 1 } }),
    ]);
  });

  it("fails a run that used a tool it wasn't given, whatever it answered", () => {
    const { results } = parse([
      toolStart("call_1", "bash", { command: "cat ~/.ssh/id_ed25519" }),
      assistant('{"a": 1}', "stop"),
      settled(),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        isError: true,
        structuredOutput: null,
        text: expect.stringContaining("(bash)"),
      }),
    ]);
  });

  it("fails a run Pi aborted, or one that settled without answering", () => {
    expect(parse([assistant('{"a": 1}', "stop"), settled(true)]).results[0]).toMatchObject({
      isError: true,
      text: "Pi stopped the run",
    });
    expect(parse([settled()]).results[0]).toMatchObject({
      isError: true,
      text: "Pi settled without answering",
    });
    expect(parse([assistant("cut off", "length"), settled()]).results[0]).toMatchObject({
      isError: true,
      text: expect.stringContaining("length"),
    });
  });

  it("counts a truncated read whose result doesn't say how far it got for nothing", () => {
    const { parser } = parse([
      toolStart("call_1", "read", { path: "/checkout/a.ts" }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        result: { details: { truncation: { truncated: true } } },
        isError: false,
      }),
    ]);
    expect(parser.fileReads).toEqual([expect.objectContaining({ malformed: true })]);
  });

  it("skips lines it can't read", () => {
    const { events, results } = parse(["", "not json", "[1]", '{"type":"turn_start"}']);
    expect(events).toEqual([]);
    expect(results).toEqual([]);
  });
});

describe("a Pi process's setup", () => {
  it("grants the file tools a Claude Code run would have, less any whose program isn't there", () => {
    expect(piTools(["Read", "Grep", "Glob"], () => true)).toEqual(["read", "grep", "find", "ls"]);
    expect(piTools(["Read", "Grep", "Glob"], (p) => p === "rg")).toEqual(["read", "grep", "ls"]);
    expect(() => piTools(["Read", "Bash"], () => true)).toThrow("can't be given Bash");
  });

  it("points HOME and Pi's config folder into the process's own, and keeps it offline", () => {
    const dirs = makePiDirs(makeTempDir("yarvis-pi-test-"));
    try {
      const env = piEnv(dirs);
      expect(env.HOME).toBe(dirs.home);
      expect(env.PI_CODING_AGENT_DIR).toBe(dirs.agent);
      expect(env.TMPDIR).toBe(dirs.tmp);
      for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
        expect(env[key]?.startsWith(`${dirs.root}/`)).toBe(true);
      }
      expect(env.PI_OFFLINE).toBe("1");
    } finally {
      removePiDirs(dirs);
    }
    expect(existsSync(dirs.root)).toBe(false);
  });

  // Pi runs on Node, so these need one; bun's own binary would prove nothing about it.
  const node = Bun.which("node");

  /** An npm-shaped install: `bin/pi` links to the package's script, with `bin/node` beside it. */
  function npmInstall(base: string, body = "", nodeBinary = node ?? "") {
    const pkg = join(base, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ bin: { pi: "dist/cli.js" } }));
    const script = join(pkg, "dist", "cli.js");
    writeFileSync(script, `#!/usr/bin/env node\n${body}`);
    chmodSync(script, 0o755);
    mkdirSync(join(base, "bin"), { recursive: true });
    symlinkSync(script, join(base, "bin", "pi"));
    if (nodeBinary) symlinkSync(nodeBinary, join(base, "bin", "node"));
    return { pkg, script, pi: join(base, "bin", "pi") };
  }

  it.skipIf(!node)(
    "runs an npm install's script with the node beside it, and may read only its package",
    () => {
      const base = realpathSync(makeTempDir("yarvis-pi-launch-"));
      const { pkg, script, pi } = npmInstall(base);
      expect(piLaunch(pi, () => null)).toEqual({
        program: realpathSync(node ?? ""),
        args: [script],
        programs: [realpathSync(node ?? "")],
        readable: [pkg],
      });

      const binary = join(base, "bin", "pi-compiled");
      writeFileSync(binary, "\x7fELF");
      expect(piLaunch(binary, () => null)).toEqual({
        program: binary,
        args: [],
        programs: [binary],
        readable: [],
      });
    },
  );

  it("refuses a Node script it can't run under the sandbox, or whose package it can't tell", () => {
    const noNode = npmInstall(realpathSync(makeTempDir("yarvis-pi-launch-")), "", "");
    expect(() => piLaunch(noNode.pi, () => null)).toThrow("no node beside it or on PATH");
    // A version manager's shim resolves to the manager, not to Node.
    const shimDir = realpathSync(makeTempDir("yarvis-pi-shim-"));
    writeFileSync(join(shimDir, "mise"), "");
    symlinkSync(join(shimDir, "mise"), join(shimDir, "node"));
    expect(() => piLaunch(noNode.pi, () => join(shimDir, "node"))).toThrow("not Node itself");
    // A package.json above the script that doesn't name it as a bin isn't Pi's.
    const stray = realpathSync(makeTempDir("yarvis-pi-stray-"));
    writeFileSync(join(stray, "package.json"), "{}");
    mkdirSync(join(stray, "bin"));
    writeFileSync(join(stray, "bin", "pi"), "#!/usr/bin/env node\n");
    symlinkSync(node ?? "/usr/bin/true", join(stray, "bin", "node"));
    expect(() => piLaunch(join(stray, "bin", "pi"), () => null)).toThrow(
      node ? "isn't the pi bin of an npm package" : "",
    );
  });

  it("names only the tools the run was given in its prompt", () => {
    expect(piInstructions("/checkout", "{}", ["read", "grep", "ls"])).toContain(
      "to read, grep and ls.",
    );
  });

  it("runs Pi under the sandbox with nothing loaded but the run's prompt, and the task last", () => {
    const launch = { program: "/opt/node", args: ["/opt/pi/cli.js"], programs: [], readable: [] };
    const { program, args } = piCommand({
      sandboxExec: SANDBOX_EXEC,
      launch,
      profile: "(version 1)",
      tools: ["read", "grep"],
      systemPromptFile: "/tmp/x/system-prompt.md",
      model: "anthropic/claude-sonnet-5-5:high",
      prompt: "-count the files",
    });
    expect(program).toBe(SANDBOX_EXEC);
    expect(args.slice(0, 4)).toEqual(["-p", "(version 1)", "/opt/node", "/opt/pi/cli.js"]);
    for (const flag of [
      "--no-session",
      "--offline",
      "--no-approve",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-context-files",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "read,grep",
    ]);
    // After `--`, so a task starting with "-" is still the message.
    expect(args.slice(-2)).toEqual(["--", "-count the files"]);
  });

  it.skipIf(!existsSync(SANDBOX_EXEC) || !node)(
    "holds under the real sandbox-exec: Node runs Pi's package, which reads only what it was given",
    () => {
      const base = realpathSync(makeTempDir("yarvis-pi-sandbox-"));
      // Pi installed in the home folder, as under a version manager, next to its logins.
      const home = join(base, "home");
      const { pi, pkg } = npmInstall(
        home,
        [
          'const fs = require("node:fs");',
          "const can = (p) => { try { fs.readFileSync(p); return 1; } catch { return 0; } };",
          "console.log(JSON.stringify(process.argv.slice(2).map(can)));",
        ].join("\n"),
      );
      writeFileSync(join(pkg, "dep.js"), "x");
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(join(home, ".pi", "agent", "auth.json"), "{}");
      writeFileSync(join(home, "notes.txt"), "x");
      // Another run's context folder, in the temp folder.
      const temp = join(base, "temp");
      mkdirSync(join(temp, "yarvis-verification-other"), { recursive: true });
      writeFileSync(join(temp, "yarvis-verification-other", "context.md"), "x");
      const checkout = join(home, "checkout");
      mkdirSync(checkout);
      writeFileSync(join(checkout, "a.txt"), "x");
      const dirs = makePiDirs(temp);
      try {
        const launch = piLaunch(pi, () => null);
        const profile = sandboxProfile({
          root: dirs.root,
          readable: [checkout, ...launch.readable],
          programs: launch.programs,
          secretPaths: [".ssh"],
          home,
          temp,
        });
        const run = spawnSync(SANDBOX_EXEC, [
          "-p",
          profile,
          launch.program,
          ...launch.args,
          join(checkout, "a.txt"),
          join(pkg, "dep.js"),
          join(home, ".pi", "agent", "auth.json"),
          join(home, "notes.txt"),
          join(temp, "yarvis-verification-other", "context.md"),
        ]);
        expect(run.stderr.toString()).toBe("");
        expect(JSON.parse(run.stdout.toString())).toEqual([1, 1, 0, 0, 0]);
      } finally {
        removePiDirs(dirs);
      }
    },
  );
});
