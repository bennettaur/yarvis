/**
 * Runs a PR's tests from the sidecar, inside a macOS Seatbelt sandbox.
 *
 * The user has already agreed to run this PR's code, and its setup script runs
 * unsandboxed, so this is defence in depth rather than the trust boundary. It
 * is still made as tight as test runners tolerate. Claude Code's sandbox only
 * wraps the commands Claude Code runs; mutation testing runs the tests itself,
 * under `sandbox-exec` with a deny-by-default profile that allows:
 *  - running programs, and signalling or inspecting only processes in the same
 *    sandbox;
 *  - reading files, except the home directory's credentials and private
 *    configuration, the rest of `~/Library`, the app's own data, and every
 *    other review checkout and clone;
 *  - writing only to the scratch copy, the run's temp folder and a few devices;
 *  - a short, vetted list of system services (logging, preferences, user and
 *    group lookup) — not LaunchServices, launchd job submission, the keychain
 *    or Apple events;
 *  - loopback networking only: binding and accepting on any loopback port,
 *    but connecting only to the ephemeral range (where a server a test starts
 *    on port 0 lands), so the database, the sidecar and other local services
 *    on fixed ports are out of reach; Unix sockets only inside the copy and
 *    temp folder. DNS is refused, since a lookup is a way out on its own.
 * The tests get a fake `HOME` in the temp folder, with tool caches pointed
 * there too and toolchain locations passed explicitly. There is no fallback:
 * where the sandbox can't be applied, or its startup check finds a gap, no test
 * runs (`SandboxUnavailableError`).
 *
 * Compiling the profile takes about three seconds (it lists every ephemeral
 * port), so a pass pays it once: `openSandboxSession` starts one small helper
 * under `sandbox-exec` and runs every command as the helper's child, which
 * inherits the sandbox. Commands are argv, never a shell line, with no
 * provider secrets or SSH agent, each in its own process group. A command
 * counts as finished when its process exits; anything it left behind is
 * killed, by process group and then by any process still working in the copy
 * or temp folder.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { SECRET_HOME_PATHS } from "../agentRuns/service.ts";
import { scrubbedEnv } from "../workspaces/exec.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** How much output is kept: the tail, where runners print their summary. */
const MAX_OUTPUT_CHARS = 64_000;

const KILL_GRACE_MS = 5_000;

/**
 * How long output may keep arriving after the command exits. A grandchild that
 * escaped the process group can hold stdout open forever; this bounds the wait.
 */
const EXIT_GRACE_MS = 2_000;

/** Withheld like the setup script's environment (see `SETUP_WITHHELD_ENV`). */
const WITHHELD_ENV = ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH", "GIT_SSH_COMMAND"];

/** The Tauri identifier, which names the app's data folders under `~/Library`. */
const APP_IDENTIFIER = "com.mikebennett.yarvis";

export class SandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(`the test sandbox is unavailable, so no tests were run: ${detail}`);
    this.name = "SandboxUnavailableError";
  }
}

/** What the sandbox does and doesn't do, for the consent prompt and the results view. */
export const SANDBOX_NOTES =
  "Mutation testing runs the pull request's tests in a macOS sandbox: no network beyond loopback, " +
  "writes only to a scratch copy and a temp folder, and no reads of your credentials, ~/Library or " +
  "other checkouts. It is a second line of defence, not a guarantee: agreeing to run this pull " +
  "request's code means trusting it, and its setup script runs without a sandbox.";

/**
 * Home-directory paths a test may not read, beyond `SECRET_HOME_PATHS`:
 * private configuration and history that says more about the user than any
 * test needs. `~/Library` as a whole goes too, apart from what toolchains read.
 */
const PRIVATE_HOME_PATHS = [
  "Library",
  ".config",
  ".zsh_history",
  ".zsh_sessions",
  ".bash_history",
  ".bash_sessions",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
  ".sqlite_history",
  ".lesshst",
  ".viminfo",
  ".terraform.d",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".bundle/config",
  ".m2/settings.xml",
  ".gradle/gradle.properties",
  ".vault-token",
  ".pgpass",
  ".my.cnf",
  ".boto",
  ".s3cfg",
];

/** Re-allowed under the paths above, because toolchains read them. */
const TOOLCHAIN_HOME_PATHS = ["Library/Python", ".config/mise"];

/**
 * Loopback ports a test may connect to: macOS's ephemeral range
 * (`net.inet.ip.portrange.first`/`last`), where a server bound to port 0 lands.
 * Seatbelt can't deny one port out of an allowed wildcard, nor express a range,
 * so the range is listed port by port; compiling that costs about three
 * seconds per command, which is the price of keeping fixed-port local services
 * — Postgres, the sidecar, Redis, Docker — unreachable. A test that connects
 * to a fixed port of its own fails its baseline and says so.
 */
const EPHEMERAL_PORTS = { first: 49152, last: 65535 };
/** Filters per rule: one rule holding all of them fails to compile. */
const PORTS_PER_RULE = 1_000;

/**
 * System services a test runner may look up. Everything here is local
 * plumbing — logging, preferences, notifications, user and group lookups,
 * temp-folder resolution, certificate trust. LaunchServices, launchd job
 * submission, the keychain (`com.apple.SecurityServer`), Apple events and
 * pasteboard are deliberately absent.
 */
const MACH_SERVICES = [
  "com.apple.system.logger",
  "com.apple.logd",
  "com.apple.diagnosticd",
  "com.apple.system.notification_center",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.system.DirectoryService.libinfo_v1",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
  "com.apple.bsd.dirhelper",
  "com.apple.trustd",
  "com.apple.trustd.agent",
  "com.apple.FSEvents",
  "com.apple.coreservices.quarantine-resolver",
];

/** A Seatbelt string literal. */
function sbString(value: string): string {
  if (/["\\\0\n]/.test(value)) throw new Error(`unsafe path for the sandbox profile: ${value}`);
  return `"${value}"`;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Where things are, for building a profile; tests supply their own. */
export interface SandboxPaths {
  /** The scratch copy; the tests' working directory. */
  copy: string;
  /** The run's temp folder; also holds the fake home. */
  tempDir: string;
  /** The user's real home, whose private parts are denied. */
  realHome: string;
  /** Review checkouts and clones live here; all but the copy are denied. */
  workspacesRoot: string;
  /**
   * Ports to keep out of reach even inside the ephemeral range: the database
   * and the sidecar, should either be configured there.
   */
  extraBlockedPorts: number[];
}

/**
 * The profile for one run. Every path is a realpath, since Seatbelt matches
 * the resolved path (`/private/var/…`, not `/var/…`). Later rules win, which
 * is how the copy and temp folder stay readable inside denied folders.
 */
export function sandboxProfile(paths: SandboxPaths): string {
  const copy = realpathSync(paths.copy);
  const temp = realpathSync(paths.tempDir);
  const home = realpathOr(paths.realHome);
  const root = realpathOr(paths.workspacesRoot);
  const sub = (path: string) => `(subpath ${sbString(path)})`;

  const deniedReads = [
    ...SECRET_HOME_PATHS.map((p) => join(home, p)),
    ...PRIVATE_HOME_PATHS.map((p) => join(home, p)),
    join(home, ".yarvis"),
    join(home, "Library", "Application Support", APP_IDENTIFIER),
    join(root, ".review"),
    join(root, ".review-repos"),
  ];
  const reallowedReads = TOOLCHAIN_HOME_PATHS.map((p) => join(home, p));
  const blocked = new Set(paths.extraBlockedPorts);
  const ports: number[] = [];
  for (let port = EPHEMERAL_PORTS.first; port <= EPHEMERAL_PORTS.last; port++) {
    if (!blocked.has(port)) ports.push(port);
  }
  const loopbackRules: string[] = [];
  for (let i = 0; i < ports.length; i += PORTS_PER_RULE) {
    const filters = ports
      .slice(i, i + PORTS_PER_RULE)
      .map((port) => `(remote ip "localhost:${port}")`);
    loopbackRules.push(`(allow network-outbound ${filters.join(" ")})`);
  }

  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow system-socket)",
    "(allow file-map-executable)",
    "(allow ipc-posix-sem*)",
    "(allow ipc-posix-shm*)",
    `(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name ${sbString(name)})`).join(" ")})`,
    "(allow file-read*)",
    `(deny file-read* ${deniedReads.map(sub).join(" ")})`,
    `(allow file-read* ${[...reallowedReads, copy, temp].map(sub).join(" ")})`,
    `(allow file-write* ${sub(copy)} ${sub(temp)} ${[
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/tty")',
      '(literal "/dev/dtracehelper")',
      '(regex #"^/dev/fd/")',
      '(regex #"^/dev/ttys[0-9]+$")',
    ].join(" ")})`,
    `(allow file-ioctl ${sub(copy)} ${sub(temp)} (subpath "/dev"))`,
    // A hard link inside the copy to a file outside it would make that file
    // writable through the copy's path.
    "(deny file-link)",
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    ...loopbackRules,
    `(allow network-bind (local unix-socket ${sub(copy)}) (local unix-socket ${sub(temp)}))`,
    `(allow network-inbound (local unix-socket ${sub(copy)}) (local unix-socket ${sub(temp)}))`,
    `(allow network-outbound (remote unix-socket ${sub(copy)}) (remote unix-socket ${sub(temp)}))`,
  ].join("\n");
}

/**
 * The run's temp folder. Under the system temp folder normally; when that is
 * the shared `/tmp`, under the app's own data folder instead.
 */
export function makeRunTempDir(systemTemp: string = tmpdir(), home: string = homedir()): string {
  let base = realpathOr(systemTemp);
  if (base === "/private/tmp" || base === "/tmp") {
    base = join(home, ".yarvis", "mutation-tmp");
    mkdirSync(base, { recursive: true, mode: 0o700 });
  }
  return mkdtempSync(join(base, "yarvis-mutation-tmp-"));
}

/**
 * Tool caches that default to somewhere under the home directory, pointed at
 * the run's temp folder, and the toolchain locations that would otherwise be
 * looked up under the (fake) home, pointed at the real ones to read.
 */
function toolEnv(tempDir: string, realHome: string): Record<string, string> {
  const existing = (path: string) => (existsSync(path) ? path : undefined);
  const env: Record<string, string | undefined> = {
    XDG_CACHE_HOME: join(tempDir, "cache"),
    GOCACHE: join(tempDir, "go-build"),
    npm_config_cache: join(tempDir, "npm"),
    YARN_CACHE_FOLDER: join(tempDir, "yarn"),
    BUN_INSTALL_CACHE_DIR: join(tempDir, "bun"),
    PIP_CACHE_DIR: join(tempDir, "pip"),
    PYTHONPYCACHEPREFIX: join(tempDir, "pycache"),
    // A mutant and its revert can land in the same second with the same size,
    // which a cached .pyc can't tell apart; never write one.
    PYTHONDONTWRITEBYTECODE: "1",
    GOPATH: process.env.GOPATH ?? existing(join(realHome, "go")),
    GOMODCACHE: process.env.GOMODCACHE,
    CARGO_HOME: process.env.CARGO_HOME ?? existing(join(realHome, ".cargo")),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? existing(join(realHome, ".rustup")),
    MISE_DATA_DIR: process.env.MISE_DATA_DIR ?? existing(join(realHome, ".local", "share", "mise")),
    MISE_CONFIG_DIR: process.env.MISE_CONFIG_DIR ?? existing(join(realHome, ".config", "mise")),
    PYTHONUSERBASE: existing(join(realHome, "Library", "Python")),
  };
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** The scrubbed environment a sandboxed command gets. Exported for tests. */
export function sandboxEnv(command: { tempDir: string; realHome: string }) {
  const fakeHome = join(command.tempDir, "home");
  return scrubbedEnv(
    {
      HOME: fakeHome,
      TMPDIR: command.tempDir,
      ...toolEnv(command.tempDir, command.realHome),
      // Runners that watch by default (vitest, jest) run once under CI.
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    [...WITHHELD_ENV, "XDG_CONFIG_HOME"],
  );
}

export interface SandboxedRun {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** The tail of stdout and stderr together. */
  output: string;
}

export interface SandboxedCommand {
  argv: string[];
  cwd: string;
  /** Where the command may write besides `cwd`; its TMPDIR and fake HOME. */
  tempDir: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Everything but `cwd` and `tempDir`; defaults to the real home and no extra ports. */
  sandbox?: Partial<Omit<SandboxPaths, "copy" | "tempDir">>;
  /** Told the process group's id once it is running, so a crash can't orphan it. */
  onSpawn?: (pgid: number) => void;
}

export type SandboxRunner = (command: SandboxedCommand) => Promise<SandboxedRun>;

/** Groups still running, killed if the sidecar exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

export function assertSandboxAvailable(): void {
  if (process.platform !== "darwin") {
    throw new SandboxUnavailableError("sandboxed test runs are only supported on macOS");
  }
  if (!existsSync(SANDBOX_EXEC)) throw new SandboxUnavailableError(`${SANDBOX_EXEC} not found`);
}

/** Configured once by the caller: the workspaces root and the ports to keep away from. */
export const sandboxDefaults: Omit<SandboxPaths, "copy" | "tempDir"> = {
  realHome: homedir(),
  workspacesRoot: homedir(),
  extraBlockedPorts: [],
};

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
  });
}

/**
 * Writes the profile where no sandboxed command can reach (it is too large for
 * an argument), and the fake home it points the tests at.
 */
function writeProfile(
  paths: Omit<SandboxPaths, "copy" | "tempDir">,
  copy: string,
  tempDir: string,
): { profileFile: string; removeProfile: () => void } {
  const profile = sandboxProfile({ ...paths, copy, tempDir });
  const profileDir = mkdtempSync(join(tmpdir(), "yarvis-sandbox-profile-"));
  const profileFile = join(profileDir, "profile.sb");
  writeFileSync(profileFile, profile, { mode: 0o600 });
  mkdirSync(join(tempDir, "home"), { recursive: true });
  return { profileFile, removeProfile: () => rmSync(profileDir, { recursive: true, force: true }) };
}

/**
 * Runs one command in a sandbox of its own: compiles the profile every time.
 * What `openSandboxSession` falls back to when it can't start its helper.
 */
export const runSandboxed: SandboxRunner = (command) => {
  assertSandboxAvailable();
  installExitHook();
  const paths = { ...sandboxDefaults, ...command.sandbox };
  const { profileFile, removeProfile } = writeProfile(paths, command.cwd, command.tempDir);
  const started = Date.now();
  return new Promise<SandboxedRun>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(SANDBOX_EXEC, ["-f", profileFile, ...command.argv], {
        cwd: command.cwd,
        env: sandboxEnv({ tempDir: command.tempDir, realHome: paths.realHome }),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      removeProfile();
      reject(e);
      return;
    }
    const pgid = child.pid;
    if (pgid !== undefined) {
      liveGroups.add(pgid);
      command.onSpawn?.(pgid);
    }

    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let exitGrace: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (pgid === undefined) return;
      killGroup(pgid, "SIGTERM");
      forceKill ??= setTimeout(() => killGroup(pgid, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, command.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (command.signal.aborted) onAbort();
    else command.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      if (exitGrace) clearTimeout(exitGrace);
      command.signal.removeEventListener("abort", onAbort);
      if (pgid !== undefined) {
        // Whatever the tests left running in the group goes with them.
        killGroup(pgid, "SIGKILL");
        liveGroups.delete(pgid);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      removeProfile();
      resolve({ exitCode, timedOut, aborted, durationMs: Date.now() - started, output });
    };
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      command.signal.removeEventListener("abort", onAbort);
      if (pgid !== undefined) liveGroups.delete(pgid);
      removeProfile();
      reject(e);
    });
    // `close` waits for the streams; an escaped grandchild holding them would
    // keep it from ever coming, so the exit plus a short grace period decides.
    child.on("exit", (code) => {
      exitGrace = setTimeout(() => finish(code), EXIT_GRACE_MS);
    });
    child.on("close", (code) => finish(code));
  });
};

/**
 * The helper that runs inside the sandbox for a whole pass. It reads one JSON
 * request per line — `{id, argv, cwd}` — and for each forks a child in its own
 * process group, `exec`s the argv directly (no shell), and streams back JSON
 * lines: `spawned` with the child's pgid at once, then `exit` with its exit
 * code or signal and the tail of its output (base64). Output stops being read
 * two seconds after the child exits, so a grandchild that escaped holding the
 * pipe can't stall it. Timeouts and cancels are the sidecar's: it signals the
 * group itself. Perl because it ships with macOS and has what this needs
 * (fork, exec, select, JSON) in its core library.
 */
const SESSION_HELPER = String.raw`
use strict; use warnings;
use JSON::PP; use MIME::Base64; use POSIX qw(:sys_wait_h); use IO::Select; use Time::HiRes qw(time);
$| = 1;
my $json = JSON::PP->new->utf8->canonical;
my ($max, $grace) = (${MAX_OUTPUT_CHARS}, ${EXIT_GRACE_MS / 1000});
sub reply { print $json->encode($_[0]), "
"; }
while (my $line = <STDIN>) {
  my $req = eval { $json->decode($line) };
  next unless ref $req eq "HASH" && ref $req->{argv} eq "ARRAY" && @{$req->{argv}};
  my ($id, $argv, $cwd) = ($req->{id}, $req->{argv}, $req->{cwd});
  my ($r, $w);
  unless (pipe($r, $w)) { reply({ id => $id, event => "error", message => "pipe: $!" }); next; }
  my $pid = fork();
  unless (defined $pid) { reply({ id => $id, event => "error", message => "fork: $!" }); next; }
  if ($pid == 0) {
    close $r;
    setpgrp(0, 0);
    open(STDIN, "<", "/dev/null");
    open(STDOUT, ">&", $w); open(STDERR, ">&", $w); close $w;
    chdir $cwd or do { print STDERR "cannot enter $cwd: $!
"; POSIX::_exit(126); };
    { no warnings; exec { $argv->[0] } @$argv; }
    print STDERR "cannot run $argv->[0]: $!
";
    POSIX::_exit(127);
  }
  setpgrp($pid, $pid);
  close $w;
  reply({ id => $id, event => "spawned", pgid => $pid });
  my $sel = IO::Select->new($r);
  my ($out, $status, $exited, $eof) = ("", undef, undef, 0);
  while (1) {
    if (!defined $status) {
      if (waitpid($pid, WNOHANG) == $pid) { $status = $?; $exited = time; }
    }
    last if defined $status && ($eof || time - $exited >= $grace);
    if ($eof) { select(undef, undef, undef, 0.05); next; }
    if ($sel->can_read(0.05)) {
      my $n = sysread($r, my $buf, 65536);
      if (!$n) { $eof = 1; next; }
      $out .= $buf;
      $out = substr($out, -$max) if length($out) > $max;
    }
  }
  close $r;
  reply({
    id => $id, event => "exit",
    code => (WIFEXITED($status) ? WEXITSTATUS($status) : undef),
    signal => (WIFSIGNALED($status) ? WTERMSIG($status) : undef),
    output => encode_base64($out, ""),
  });
}
`;

const PERL = "/usr/bin/perl";

export interface SandboxSession {
  /** Runs commands through the session's helper; every command must use the session's copy and temp folder. */
  runner: SandboxRunner;
  /** The helper's pid, which the stray sweep must spare. */
  helperPid: number | undefined;
  close: () => void;
}

/**
 * Starts one sandboxed helper for a pass, so the profile is compiled once. Falls
 * back to a sandbox per command (`runSandboxed`) when the helper can't start;
 * the protection is the same either way, only slower.
 */
export async function openSandboxSession(base: {
  cwd: string;
  tempDir: string;
  sandbox?: SandboxedCommand["sandbox"];
}): Promise<SandboxSession> {
  assertSandboxAvailable();
  if (!existsSync(PERL)) {
    console.log("[mutation-testing] no perl for the sandbox helper; sandboxing each command");
    return { runner: runSandboxed, helperPid: undefined, close: () => {} };
  }
  installExitHook();
  const paths = { ...sandboxDefaults, ...base.sandbox };
  const { profileFile, removeProfile } = writeProfile(paths, base.cwd, base.tempDir);
  let helper: ChildProcess;
  try {
    helper = spawn(SANDBOX_EXEC, ["-f", profileFile, PERL, "-e", SESSION_HELPER], {
      cwd: base.cwd,
      env: sandboxEnv({ tempDir: base.tempDir, realHome: paths.realHome }),
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    removeProfile();
    throw e;
  }
  const helperPid = helper.pid;
  if (helperPid !== undefined) liveGroups.add(helperPid);

  type Pending = {
    onSpawned: (pgid: number) => void;
    onExit: (reply: { code: number | null; signal: number | null; output: string }) => void;
    onError: (message: string) => void;
  };
  const pending = new Map<number, Pending>();
  let broken: string | null = null;
  let helperErrors = "";
  helper.stderr?.on("data", (chunk: Buffer) => {
    helperErrors = (helperErrors + chunk.toString("utf8")).slice(-2_000);
  });
  const fail = (message: string) => {
    broken ??= message;
    for (const entry of pending.values()) entry.onError(broken);
    pending.clear();
  };
  helper.on("exit", () => {
    if (helperPid !== undefined) liveGroups.delete(helperPid);
    removeProfile();
    fail(`the sandbox helper stopped${helperErrors ? `: ${helperErrors.trim()}` : ""}`);
  });
  helper.on("error", (e) => fail(`the sandbox helper failed: ${e.message}`));
  if (helper.stdout) {
    createInterface({ input: helper.stdout }).on("line", (line) => {
      let reply: Record<string, unknown>;
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      const entry = pending.get(Number(reply.id));
      if (!entry) return;
      if (reply.event === "spawned") entry.onSpawned(Number(reply.pgid));
      else if (reply.event === "exit") {
        pending.delete(Number(reply.id));
        entry.onExit({
          code: typeof reply.code === "number" ? reply.code : null,
          signal: typeof reply.signal === "number" ? reply.signal : null,
          output: Buffer.from(String(reply.output ?? ""), "base64").toString("utf8"),
        });
      } else if (reply.event === "error") {
        pending.delete(Number(reply.id));
        entry.onError(String(reply.message));
      }
    });
  }

  let nextId = 1;
  const runner: SandboxRunner = (command) => {
    if (command.cwd !== base.cwd || command.tempDir !== base.tempDir) {
      return Promise.reject(new Error("a sandbox session runs commands in its own copy only"));
    }
    if (broken) return Promise.reject(new SandboxUnavailableError(broken));
    const id = nextId++;
    const started = Date.now();
    return new Promise<SandboxedRun>((resolve, reject) => {
      let pgid: number | undefined;
      let timedOut = false;
      let aborted = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (pgid === undefined) return;
        killGroup(pgid, "SIGTERM");
        forceKill ??= setTimeout(
          () => pgid !== undefined && killGroup(pgid, "SIGKILL"),
          KILL_GRACE_MS,
        );
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, command.timeoutMs);
      const onAbort = () => {
        aborted = true;
        stop();
      };
      const settle = () => {
        clearTimeout(timer);
        if (forceKill) clearTimeout(forceKill);
        command.signal.removeEventListener("abort", onAbort);
        if (pgid !== undefined) {
          // Whatever the command left running in its group goes with it.
          killGroup(pgid, "SIGKILL");
          liveGroups.delete(pgid);
        }
      };
      pending.set(id, {
        onSpawned: (spawned) => {
          pgid = spawned;
          liveGroups.add(spawned);
          command.onSpawn?.(spawned);
          if (aborted || timedOut) stop();
        },
        onExit: ({ code, output }) => {
          settle();
          resolve({ exitCode: code, timedOut, aborted, durationMs: Date.now() - started, output });
        },
        onError: (message) => {
          settle();
          reject(new SandboxUnavailableError(message));
        },
      });
      if (command.signal.aborted) onAbort();
      else command.signal.addEventListener("abort", onAbort, { once: true });
      helper.stdin?.write(`${JSON.stringify({ id, argv: command.argv, cwd: command.cwd })}\n`);
    });
  };

  return {
    runner,
    helperPid,
    close: () => {
      helper.stdin?.end();
      if (helperPid !== undefined) killGroup(helperPid, "SIGKILL");
    },
  };
}

/** Lists processes as `pid` with their working directory, from `lsof`. */
function processCwds(): Promise<{ pid: number; path: string }[]> {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-d", "cwd", "-Fpn"], { maxBuffer: 16 * 1024 * 1024 }, (_e, out) => {
      const found: { pid: number; path: string }[] = [];
      let pid = 0;
      for (const line of (out ?? "").split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid) found.push({ pid, path: line.slice(1) });
      }
      resolve(found);
    });
  });
}

/** Lists processes with their executable's path, from `ps`. */
function processExecutables(): Promise<{ pid: number; path: string }[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,comm="], { maxBuffer: 16 * 1024 * 1024 }, (_e, out) => {
      resolve(
        (out ?? "")
          .split("\n")
          .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => ({ pid: Number(m[1]), path: m[2] as string })),
      );
    });
  });
}

/**
 * Kills every process working in, or run from, one of `roots`: what a test
 * left behind outside its process group (a daemon that called `setsid`, say).
 * Returns the pids it killed. Never this process.
 */
export async function killStrays(
  roots: string[],
  spare: ReadonlySet<number> = new Set(),
): Promise<number[]> {
  const prefixes = roots.flatMap((root) => {
    const real = realpathOr(root);
    return [...new Set([root, real])].map((p) => (p.endsWith(sep) ? p : `${p}${sep}`));
  });
  const under = (path: string) => prefixes.some((prefix) => `${path}${sep}`.startsWith(prefix));
  const [cwds, executables] = await Promise.all([processCwds(), processExecutables()]);
  const pids = new Set(
    [...cwds, ...executables]
      .filter((p) => p.pid !== process.pid && !spare.has(p.pid) && under(p.path))
      .map((p) => p.pid),
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return [...pids];
}

/** The startup check's probes, run as one script so the profile compiles once. */
const PROBE_SCRIPT = `
probe() { name=$1; shift; out=$("$@" 2>&1); code=$?; printf '@@%s|%s|%s\\n' "$name" "$code" "$(printf '%s' "$out" | tr '\\n' ' ' | cut -c1-400)"; }
probe write /bin/sh -c 'echo escaped > "$1"' sh "$1"
probe link /bin/sh -c 'ln "$1" link-probe && echo escaped >> link-probe' sh "$2"
probe secret /bin/ls "$3"
probe network /usr/bin/nc -v -z -G 2 192.0.2.1 443
probe service /usr/bin/nc -v -z -G 2 127.0.0.1 "$5"
probe dns /usr/bin/dscacheutil -q host -a name example.com
probe unix /usr/bin/nc -U -z /private/var/run/mDNSResponder
probe launchd /bin/launchctl submit -l "$4" -- /usr/bin/true
probe launchservices /usr/bin/lsappinfo front
probe keychain /usr/bin/security show-keychain-info /Library/Keychains/System.keychain
`;

const REFUSED = "Operation not permitted";

/**
 * Checks, before any test runs, that the sandbox applies and holds. One
 * sandboxed script tries each of these, and every one must be refused: a
 * write next to the copy; a hard link to a file outside it, written through;
 * a read of a credential folder; an outbound connection; a connection to a
 * local service port (the database's); a DNS lookup; a Unix socket outside the
 * copy; submitting a launchd job; a LaunchServices query; a keychain query.
 * A sandbox that can't be applied (a nested one, say) fails here rather than
 * letting a test run outside it.
 */
export async function checkSandbox(
  runner: SandboxRunner,
  dirs: { cwd: string; tempDir: string; outside: string; signal?: AbortSignal },
  sandbox?: SandboxedCommand["sandbox"],
): Promise<void> {
  const signal = dirs.signal ?? new AbortController().signal;
  const tag = `yarvis-sandbox-probe-${process.pid}-${Date.now()}`;
  const outsideWrite = join(dirs.outside, `.${tag}-write`);
  const outsideTarget = join(dirs.outside, `.${tag}-target`);
  writeFileSync(outsideTarget, "untouched\n");
  const realHome = sandbox?.realHome ?? sandboxDefaults.realHome;
  const secretDir =
    SECRET_HOME_PATHS.map((p) => join(realHome, p)).find((p) => existsSync(p)) ??
    join(realHome, "Library");
  const servicePort = String(
    (sandbox?.extraBlockedPorts ?? sandboxDefaults.extraBlockedPorts)[0] ?? 5432,
  );

  try {
    const run = await runner({
      argv: [
        "/bin/sh",
        "-c",
        PROBE_SCRIPT,
        "sh",
        outsideWrite,
        outsideTarget,
        secretDir,
        tag,
        servicePort,
      ],
      cwd: dirs.cwd,
      tempDir: dirs.tempDir,
      timeoutMs: 60_000,
      signal,
      sandbox,
    });
    if (signal.aborted || run.aborted) return;
    const results = new Map<string, { code: number; out: string }>();
    for (const match of run.output.matchAll(/^@@([a-z]+)\|(\d+)\|(.*)$/gm)) {
      results.set(match[1] as string, { code: Number(match[2]), out: match[3] ?? "" });
    }
    if (results.size === 0) {
      throw new SandboxUnavailableError(run.output.trim().slice(0, 500) || "it did not start");
    }
    const get = (name: string) => results.get(name) ?? { code: -1, out: "" };
    const escaped: [string, boolean][] = [
      ["a write outside the copy", existsSync(outsideWrite)],
      [
        "a hard link to a file outside the copy",
        !readFileSync(outsideTarget, "utf8").startsWith("untouched"),
      ],
      ["a read of a credential folder", !get("secret").out.includes(REFUSED)],
      ["an outbound connection", !get("network").out.includes(REFUSED)],
      ["a connection to a local service port", !get("service").out.includes(REFUSED)],
      ["a DNS lookup", /ip_address|ipv6_address/.test(get("dns").out)],
      ["a Unix socket outside the copy", get("unix").code === 0],
      ["submitting a launchd job", get("launchd").code === 0],
      ["a LaunchServices query", /ASN:/.test(get("launchservices").out)],
      ["a keychain query", /lock-on-sleep|no-timeout|timeout=/.test(get("keychain").out)],
    ];
    if (get("launchd").code === 0) execFile("/bin/launchctl", ["remove", tag], () => {});
    const gap = escaped.find(([, through]) => through);
    if (gap) throw new SandboxUnavailableError(`${gap[0]} was not refused`);
  } finally {
    rmSync(outsideWrite, { force: true });
    rmSync(outsideTarget, { force: true });
    rmSync(join(dirs.cwd, "link-probe"), { force: true });
  }
}
