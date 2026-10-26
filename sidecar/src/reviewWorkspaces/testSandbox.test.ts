import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTestCounts } from "./testCommands.ts";
import {
  checkSandbox,
  killStrays,
  makeRunTempDir,
  openSandboxSession,
  runSandboxed,
  type SandboxedCommand,
  type SandboxRunner,
  SandboxUnavailableError,
  sandboxEnv,
  sandboxProfile,
} from "./testSandbox.ts";

let root: string;
/** Where review checkouts live; the copy is one of them. */
let workspacesRoot: string;
let cwd: string;
let otherCheckout: string;
let tempDir: string;
let outside: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "yarvis-sandbox-")));
  workspacesRoot = join(root, "workspaces");
  cwd = join(workspacesRoot, ".review", "ws", "gh-o-r-1-mutants-x");
  otherCheckout = join(workspacesRoot, ".review", "other", "gh-o-r-2");
  tempDir = join(root, "tmp");
  outside = join(root, "outside");
  home = join(root, "home");
  for (const dir of [
    cwd,
    otherCheckout,
    join(workspacesRoot, ".review-repos", "github", "o", "r"),
    tempDir,
    outside,
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".config", "gh"),
    join(home, ".config", "mise"),
    join(home, "Library", "Keychains"),
    join(home, "Library", "Python", "3.9"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
  writeFileSync(join(home, ".aws", "credentials"), "aws_secret_access_key=x\n");
  writeFileSync(join(home, ".netrc"), "machine x password y\n");
  writeFileSync(join(home, ".zsh_history"), "export TOKEN=hunter2\n");
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: gho_x\n");
  writeFileSync(join(home, ".config", "mise", "config.toml"), "[tools]\n");
  writeFileSync(join(home, "Library", "Keychains", "login.keychain-db"), "KEYCHAIN\n");
  writeFileSync(join(home, "Library", "Python", "3.9", "site.txt"), "user site\n");
  writeFileSync(join(home, "notes.txt"), "not a secret\n");
  writeFileSync(join(root, "sibling.txt"), "another run's file\n");
  writeFileSync(join(otherCheckout, "secret.ts"), "OTHER CHECKOUT\n");
  writeFileSync(join(workspacesRoot, ".review-repos", "github", "o", "r", "HEAD"), "CLONE\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sandbox = () => ({ realHome: home, workspacesRoot, extraBlockedPorts: [] as number[] });

const run = (argv: string[], extra: Partial<SandboxedCommand> = {}) =>
  runSandboxed({
    argv,
    cwd,
    tempDir,
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    sandbox: sandbox(),
    ...extra,
  });
const sh = (script: string, extra: Partial<SandboxedCommand> = {}) =>
  run(["/bin/sh", "-c", script], extra);

describe("the sandbox profile", () => {
  it("denies by default and opens only what tests need", () => {
    const profile = sandboxProfile({
      ...sandbox(),
      copy: cwd,
      tempDir,
      extraBlockedPorts: [50000],
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(deny file-link)");
    expect(profile).toContain('(remote ip "localhost:49152")');
    expect(profile).toContain('(remote ip "localhost:65535")');
    expect(profile).not.toContain('(remote ip "localhost:50000")');
    expect(profile).not.toContain('(remote ip "localhost:5432")');
    expect(profile).not.toContain('(remote ip "localhost:*")');
    expect(profile).not.toContain("com.apple.SecurityServer");
    expect(profile).not.toContain("com.apple.coreservices.launchservicesd");
    expect(profile).not.toContain("com.apple.FSEvents");
    expect(profile).not.toContain("com.apple.system.notification_center");
    expect(profile).toContain("(deny syscall-unix (syscall-number SYS_setsid))");
    // The home directory is denied as a whole; only toolchains come back.
    expect(profile).toContain(`(deny file-read* (subpath "${realpathSync(home)}")`);
    expect(profile).toContain(`(subpath "${join(realpathSync(home), ".config", "mise")}")`);
    // No terminals, and no binding a service port to pose as it.
    expect(profile).not.toContain("ttys[0-9]");
    expect(profile).toContain('(deny file-write* (regex #"^/dev/(ttys|pty)"))');
    expect(profile).toMatch(/\(deny network-bind [^\n]*"localhost:5432"/);
    expect(profile).toMatch(/\(deny network-bind [^\n]*"localhost:50000"/);
  });

  it("refuses a path that could break out of its string", () => {
    expect(() =>
      sandboxProfile({
        ...sandbox(),
        copy: cwd,
        tempDir: '/tmp/a")(allow default',
        extraBlockedPorts: [],
      }),
    ).toThrow();
  });
});

describe("the environment tests get", () => {
  it("has a fake home with tool caches in the temp folder, and no agent or secrets", () => {
    const env = sandboxEnv({ tempDir: "/tmp/run", realHome: home });
    expect(env.HOME).toBe("/tmp/run/home");
    expect(env.TMPDIR).toBe("/tmp/run");
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
    expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
    // Toolchain locations that would be looked up under HOME point at the real ones.
    expect(env.MISE_CONFIG_DIR).toBe(join(home, ".config", "mise"));
    expect(env.PYTHONUSERBASE).toBe(join(home, "Library", "Python"));
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });
});

describe("the run's temp folder", () => {
  it("stays out of a shared /tmp", () => {
    const fakeHome = join(root, "apphome");
    const dir = makeRunTempDir("/tmp", fakeHome);
    expect(dir.startsWith(join(fakeHome, ".yarvis", "mutation-tmp"))).toBe(true);
    expect(statSync(join(fakeHome, ".yarvis", "mutation-tmp")).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
    const normal = makeRunTempDir(root, fakeHome);
    expect(normal.startsWith(root)).toBe(true);
  });
});

// sandbox-exec is macOS-only; elsewhere these runs are refused outright.
describe.skipIf(process.platform !== "darwin")("running a command in the sandbox", () => {
  // Each sandboxed run compiles a profile listing every ephemeral port: ~3s.
  const SLOW = 90_000;
  it(
    "lets it write in the copy and its temp folder, and nowhere else",
    async () => {
      const result = await sh(
        `echo a > ok.txt && echo b > "$TMPDIR/ok.txt" && echo c > "$HOME/ok.txt" && echo ok; echo d > "${outside}/bad.txt"; echo e > "${home}/bad.txt"; echo f > "${otherCheckout}/bad.txt"; true`,
      );
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(cwd, "ok.txt"))).toBe(true);
      expect(existsSync(join(tempDir, "ok.txt"))).toBe(true);
      expect(existsSync(join(tempDir, "home", "ok.txt"))).toBe(true);
      for (const bad of [
        join(outside, "bad.txt"),
        join(home, "bad.txt"),
        join(otherCheckout, "bad.txt"),
      ]) {
        expect(existsSync(bad)).toBe(false);
      }
    },
    SLOW,
  );

  it(
    "refuses a hard link to a file outside, so nothing is written through it",
    async () => {
      writeFileSync(join(outside, "target.txt"), "untouched\n");
      const result = await sh(
        `ln "${outside}/target.txt" link.txt; echo escaped >> link.txt; true`,
      );
      expect(result.output).toContain("Operation not permitted");
      expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("untouched\n");
    },
    SLOW,
  );

  it(
    "refuses reads of the home folder beyond toolchains, other temp folders and other checkouts",
    async () => {
      const paths = [
        ".ssh/id_ed25519",
        ".aws/credentials",
        ".netrc",
        ".zsh_history",
        ".config/gh/hosts.yml",
        "Library/Keychains/login.keychain-db",
      ].map((p) => `"${join(home, p)}"`);
      const result = await sh(
        `cat ${paths.join(" ")} "${otherCheckout}/secret.ts" "${workspacesRoot}/.review-repos/github/o/r/HEAD" "${home}/notes.txt" "${root}/sibling.txt"; cat "${home}/.config/mise/config.toml" "${home}/Library/Python/3.9/site.txt"`,
      );
      for (const secret of [
        "PRIVATE KEY",
        "aws_secret_access_key",
        "password",
        "hunter2",
        "gho_x",
        "KEYCHAIN",
        "OTHER CHECKOUT",
        "CLONE",
        "not a secret",
        "another run's file",
      ]) {
        expect(result.output).not.toContain(secret);
      }
      expect(result.output).toContain("[tools]");
      expect(result.output).toContain("user site");
    },
    SLOW,
  );

  it(
    "refuses the network and DNS, and loopback but to the ephemeral range",
    async () => {
      // 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, so nothing could leave
      // even if the sandbox let it; a denial shows as EPERM at once.
      const script = [
        "import errno, socket",
        "def attempt(label, fn):",
        "    try:",
        "        fn(); print(label, 'ok')",
        "    except OSError as e:",
        "        print(label, 'denied' if e.errno == errno.EPERM else f'failed {e}')",
        "attempt('remote', lambda: socket.create_connection(('192.0.2.1', 443), timeout=3))",
        "try:",
        "    socket.getaddrinfo('example.com', 443); print('dns ok')",
        "except OSError:",
        "    print('dns failed')",
        "eph = socket.socket(); eph.bind(('127.0.0.1', 0)); eph.listen()",
        "attempt('ephemeral', lambda: socket.create_connection(('127.0.0.1', eph.getsockname()[1]), timeout=3))",
        "fixed = socket.socket(); fixed.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
        "fixed.bind(('127.0.0.1', 23456)); fixed.listen()",
        "attempt('fixed', lambda: socket.create_connection(('127.0.0.1', 23456), timeout=3))",
        "squat = socket.socket(); squat.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
        "attempt('service-bind', lambda: squat.bind(('127.0.0.1', 11434)))",
        "srv = socket.socket(socket.AF_UNIX); srv.bind('s.sock'); srv.listen()",
        "attempt('unix-inside', lambda: socket.socket(socket.AF_UNIX).connect('s.sock'))",
        "attempt('unix-outside', lambda: socket.socket(socket.AF_UNIX).connect('/private/var/run/mDNSResponder'))",
      ].join("\n");
      writeFileSync(join(cwd, "net.py"), script);
      const result = await run(["/usr/bin/python3", "net.py"]);
      expect(result.output).toContain("remote denied");
      expect(result.output).toContain("dns failed");
      expect(result.output).toContain("ephemeral ok");
      expect(result.output).toContain("fixed denied");
      expect(result.output).toContain("service-bind denied");
      expect(result.output).toContain("unix-inside ok");
      expect(result.output).toContain("unix-outside denied");
    },
    SLOW,
  );

  it(
    "refuses setsid and terminals",
    async () => {
      const result = await sh(
        `/usr/bin/perl -MPOSIX -e 'print((POSIX::setsid() // -1) > 0 ? "new session\\n" : "setsid: $!\\n")'; : > /dev/ttys000`,
      );
      expect(result.output).toContain("setsid: Operation not permitted");
      expect(result.output).not.toContain("new session");
      expect(result.output).toMatch(/ttys000: Operation not permitted/);
    },
    SLOW,
  );

  it(
    "kills the whole process group on a timeout",
    async () => {
      const started = Date.now();
      const result = await sh("sleep 30 & sleep 30", { timeoutMs: 300 });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    SLOW,
  );

  it(
    "doesn't wait on a process that left the group holding its output, and the sweep kills it",
    async () => {
      const started = Date.now();
      const result = await sh(`/usr/bin/perl -e 'setpgrp(0, 0); sleep 30' & echo started`);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("started");
      expect(Date.now() - started).toBeLessThan(15_000);
      const killed = await killStrays([cwd, tempDir]);
      expect(killed.length).toBeGreaterThan(0);
      expect(await killStrays([cwd, tempDir])).toEqual([]);
    },
    SLOW,
  );

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
      const result = await run(argv, {
        timeoutMs: 120_000,
        sandbox: { ...sandbox(), realHome: process.env.HOME as string },
      });
      expect(result.exitCode).toBe(0);
      expect(parseTestCounts(argv, result.output)).toEqual({ total: 1, failed: 0 });
      expect(existsSync(join(tempDir, "go-build"))).toBe(true);
    },
    SLOW,
  );

  it(
    "passes the startup check, which an unsandboxed runner fails",
    async () => {
      await checkSandbox(runSandboxed, { cwd, tempDir, outside }, sandbox());
      // A runner that let everything through, as its probe output would show.
      // (Not a real unsandboxed run: that would submit a launchd job for real.)
      const unsandboxed: SandboxRunner = async () => ({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        durationMs: 0,
        output: ["@@secret|0|id_ed25519", "@@network|0|Connection to 192.0.2.1 succeeded"].join(
          "\n",
        ),
      });
      await expect(checkSandbox(unsandboxed, { cwd, tempDir, outside }, sandbox())).rejects.toThrow(
        "was not refused",
      );
      expect(readdirSync(outside)).toEqual([]);
    },
    SLOW,
  );
});

describe.skipIf(process.platform !== "darwin")("a sandbox session for a whole pass", () => {
  const SLOW = 90_000;
  const open = () => openSandboxSession({ cwd, tempDir, sandbox: sandbox() });
  const command = (argv: string[], extra: Partial<SandboxedCommand> = {}): SandboxedCommand => ({
    argv,
    cwd,
    tempDir,
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    sandbox: sandbox(),
    ...extra,
  });

  it(
    "compiles the profile once, and its commands are as confined as a sandbox of their own",
    async () => {
      const session = await open();
      try {
        await session.runner(command(["/usr/bin/true"]));
        const started = Date.now();
        const second = await session.runner(command(["/usr/bin/true"]));
        expect(second.exitCode).toBe(0);
        expect(Date.now() - started).toBeLessThan(500);

        // Argv only: nothing is read by a shell.
        const echoed = await session.runner(command(["/bin/echo", "$HOME; ls"]));
        expect(echoed.output.trim()).toBe("$HOME; ls");

        const writes = await session.runner(
          command(["/bin/sh", "-c", `echo a > ok.txt; echo b > "${outside}/bad.txt"; true`]),
        );
        expect(writes.exitCode).toBe(0);
        expect(existsSync(join(cwd, "ok.txt"))).toBe(true);
        expect(existsSync(join(outside, "bad.txt"))).toBe(false);

        await checkSandbox(session.runner, { cwd, tempDir, outside }, sandbox());
      } finally {
        session.close();
      }
    },
    SLOW,
  );

  it(
    "times out and cancels one command without ending the session",
    async () => {
      const session = await open();
      try {
        const timedOut = await session.runner(command(["/bin/sleep", "30"], { timeoutMs: 300 }));
        expect(timedOut.timedOut).toBe(true);
        const controller = new AbortController();
        const cancelled = session.runner(
          command(["/bin/sleep", "30"], { signal: controller.signal }),
        );
        setTimeout(() => controller.abort(), 200);
        expect((await cancelled).aborted).toBe(true);
        const after = await session.runner(command(["/bin/echo", "still here"]));
        expect(after.output.trim()).toBe("still here");
      } finally {
        session.close();
      }
    },
    SLOW,
  );

  it(
    "doesn't wait on an escaped grandchild, and the stray sweep spares only the helper",
    async () => {
      const session = await open();
      try {
        const started = Date.now();
        const result = await session.runner(
          command(["/bin/sh", "-c", "/usr/bin/perl -e 'setpgrp(0, 0); sleep 30' & echo started"]),
        );
        expect(result.output).toContain("started");
        expect(Date.now() - started).toBeLessThan(15_000);
        const spare = new Set([session.helperPid as number]);
        const killed = await killStrays([cwd, tempDir], spare);
        expect(killed.length).toBeGreaterThan(0);
        expect(killed).not.toContain(session.helperPid);
        // The helper survived the sweep and still runs commands.
        expect((await session.runner(command(["/bin/echo", "ok"]))).output.trim()).toBe("ok");
      } finally {
        session.close();
      }
    },
    SLOW,
  );

  it(
    "finds an escapee that tried setsid, left the copy and became a system binary",
    async () => {
      const session = await open();
      try {
        // The escapee can't leave the session; it changes group, leaves the
        // copy, outlives its parent and becomes /usr/bin/perl.
        await session.runner(
          command([
            "/bin/sh",
            "-c",
            `/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); setpgrp(0, 0); chdir "/"; exec "/usr/bin/perl", "-e", "sleep 60"' & sleep 0.5; echo started`,
          ]),
        );
        // Not under the copy or temp folder any more, by cwd or executable.
        expect(await killStrays([cwd, tempDir], new Set([session.helperPid as number]))).toEqual(
          [],
        );
        const killed = await session.sweep();
        expect(killed.length).toBeGreaterThan(0);
        await Bun.sleep(200);
        expect(await session.sweep()).toEqual([]);
      } finally {
        session.close();
      }
    },
    SLOW,
  );

  it(
    "kills a command that moved itself into the helper's group",
    async () => {
      const session = await open();
      try {
        const started = Date.now();
        const result = await session.runner(
          command(["/usr/bin/perl", "-e", "setpgrp(0, getpgrp(getppid())); sleep 60"], {
            timeoutMs: 300,
          }),
        );
        expect(result.timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect((await session.runner(command(["/bin/echo", "ok"]))).output.trim()).toBe("ok");
      } finally {
        session.close();
      }
    },
    SLOW,
  );

  it(
    "ends the session when the helper stops answering",
    async () => {
      const session = await open();
      try {
        const run = session.runner(command(["/bin/sleep", "60"], { timeoutMs: 300 }));
        await Bun.sleep(100);
        process.kill(session.helperPid as number, "SIGSTOP");
        await expect(run).rejects.toThrow("stopped answering");
        await expect(session.runner(command(["/usr/bin/true"]))).rejects.toBeInstanceOf(
          SandboxUnavailableError,
        );
      } finally {
        session.close();
      }
    },
    SLOW,
  );

  it(
    "refuses commands once its helper has gone",
    async () => {
      const session = await open();
      session.close();
      await Bun.sleep(200);
      await expect(session.runner(command(["/usr/bin/true"]))).rejects.toBeInstanceOf(
        SandboxUnavailableError,
      );
    },
    SLOW,
  );
});
