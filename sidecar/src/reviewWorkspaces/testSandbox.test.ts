import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTestCounts } from "./testCommands.ts";
import {
  checkSandbox,
  runSandboxed,
  type SandboxedCommand,
  type SandboxRunner,
  sandboxEnv,
  sandboxProfile,
} from "./testSandbox.ts";

let root: string;
let cwd: string;
let tempDir: string;
let outside: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yarvis-sandbox-"));
  cwd = join(root, "copy");
  tempDir = join(root, "tmp");
  outside = join(root, "outside");
  home = join(root, "home");
  for (const dir of [cwd, tempDir, outside, join(home, ".ssh"), join(home, ".aws")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
  writeFileSync(join(home, ".aws", "credentials"), "aws_secret_access_key=x\n");
  writeFileSync(join(home, ".netrc"), "machine x password y\n");
  writeFileSync(join(home, "notes.txt"), "not a secret\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sh = (script: string, extra: Partial<SandboxedCommand> = {}) =>
  runSandboxed({
    argv: ["/bin/sh", "-c", script],
    cwd,
    tempDir,
    timeoutMs: 20_000,
    signal: new AbortController().signal,
    home,
    ...extra,
  });

describe("the sandbox profile", () => {
  it("denies the network and every write outside the copy and temp, and the secret paths", () => {
    const profile = sandboxProfile({ writable: [cwd, tempDir], home });
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("mDNSResponder");
    expect(profile).toContain(".ssh");
    expect(profile).toContain(".claude/.credentials.json");
  });

  it("points the tool caches at the run's temp folder, not the home directory", () => {
    const env = sandboxEnv({ tempDir: "/tmp/run", home: "/Users/me" });
    for (const key of [
      "XDG_CACHE_HOME",
      "GOCACHE",
      "npm_config_cache",
      "YARN_CACHE_FOLDER",
      "BUN_INSTALL_CACHE_DIR",
      "PIP_CACHE_DIR",
      "PYTHONPYCACHEPREFIX",
    ]) {
      expect(env[key]?.startsWith("/tmp/run/")).toBe(true);
    }
    expect(env.TMPDIR).toBe("/tmp/run");
    expect(env.GOMODCACHE).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("refuses a path that could break out of its string", () => {
    expect(() => sandboxProfile({ writable: ['/tmp/a")(allow default'] })).toThrow();
  });
});

// sandbox-exec is macOS-only; elsewhere these runs are refused outright.
describe.skipIf(process.platform !== "darwin")("running a command in the sandbox", () => {
  it("lets it write in the copy and its temp folder, and nowhere else", async () => {
    const run = await sh(
      `echo a > ok.txt && echo b > "$TMPDIR/ok.txt" && echo ok; echo c > "${outside}/bad.txt"; echo d > "$HOME/bad.txt"; true`,
    );
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(cwd, "ok.txt"))).toBe(true);
    expect(existsSync(join(tempDir, "ok.txt"))).toBe(true);
    expect(existsSync(join(outside, "bad.txt"))).toBe(false);
    expect(existsSync(join(home, "bad.txt"))).toBe(false);
    expect(run.output).toContain("Operation not permitted");
  });

  it("refuses reads of the home directory's credentials, and allows the rest", async () => {
    const run = await sh(
      'cat "$HOME/.ssh/id_ed25519"; cat "$HOME/.aws/credentials"; cat "$HOME/.netrc"; ls "$HOME/.ssh"; cat "$HOME/notes.txt"',
    );
    expect(run.output).not.toContain("PRIVATE KEY");
    expect(run.output).not.toContain("aws_secret_access_key");
    expect(run.output).not.toContain("password");
    expect(run.output).toContain("not a secret");
  });

  it("refuses the network and DNS, but not loopback", async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, so nothing could leave
    // even if the sandbox let it; a denial shows as EPERM at once.
    const script = [
      "import errno, socket",
      "try:",
      "    socket.create_connection(('192.0.2.1', 443), timeout=3); print('remote: connected')",
      "except OSError as e:",
      "    print('remote:', 'denied' if e.errno == errno.EPERM else e)",
      "try:",
      "    socket.getaddrinfo('example.com', 443); print('dns: resolved')",
      "except OSError as e:",
      "    print('dns: failed')",
      "s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen()",
      "socket.create_connection(('127.0.0.1', s.getsockname()[1]), timeout=3); print('loopback: ok')",
    ].join("\n");
    writeFileSync(join(cwd, "net.py"), script);
    const run = await runSandboxed({
      argv: ["/usr/bin/python3", "net.py"],
      cwd,
      tempDir,
      timeoutMs: 20_000,
      signal: new AbortController().signal,
      home,
    });
    expect(run.output).toContain("remote: denied");
    expect(run.output).toContain("dns: failed");
    expect(run.output).toContain("loopback: ok");
  });

  // Go writes its build cache under ~/Library/Caches by default, which the
  // sandbox refuses; GOCACHE in the run's temp folder is what lets it build.
  it.skipIf(!Bun.which("go"))(
    "gets `go test` past its baseline with its cache in temp",
    async () => {
      writeFileSync(join(cwd, "go.mod"), "module example.com/pricing\n\ngo 1.21\n");
      writeFileSync(
        join(cwd, "fee.go"),
        "package pricing\n\nfunc Fee(t int) int {\n\tif t >= 50 {\n\t\treturn 0\n\t}\n\treturn 5\n}\n",
      );
      writeFileSync(
        join(cwd, "fee_test.go"),
        'package pricing\n\nimport "testing"\n\nfunc TestFee(t *testing.T) {\n\tif Fee(50) != 0 {\n\t\tt.Fatal("fee")\n\t}\n}\n',
      );
      const argv = ["go", "test", "-v", "./..."];
      const run = await runSandboxed({
        argv,
        cwd,
        tempDir,
        timeoutMs: 120_000,
        signal: new AbortController().signal,
        home,
      });
      expect(run.exitCode).toBe(0);
      expect(parseTestCounts(argv, run.output)).toEqual({ total: 1, failed: 0 });
      expect(existsSync(join(tempDir, "go-build"))).toBe(true);
    },
  );

  it("kills the whole process group on a timeout", async () => {
    const started = Date.now();
    const run = await sh("sleep 30 & sleep 30", { timeoutMs: 300 });
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("passes the startup check, which an unsandboxed runner fails", async () => {
    await checkSandbox(runSandboxed, { cwd, tempDir, outside });
    const unsandboxed: SandboxRunner = async (command) => {
      const result = spawnSync(command.argv[0] as string, command.argv.slice(1), {
        cwd: command.cwd,
        encoding: "utf8",
      });
      return {
        exitCode: result.status,
        timedOut: false,
        aborted: false,
        durationMs: 0,
        output: `${result.stdout}${result.stderr}`,
      };
    };
    await expect(checkSandbox(unsandboxed, { cwd, tempDir, outside })).rejects.toThrow(
      "was not refused",
    );
    expect(existsSync(join(outside, `.yarvis-sandbox-probe-${process.pid}`))).toBe(false);
  });
});
