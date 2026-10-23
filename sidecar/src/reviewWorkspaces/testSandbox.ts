/**
 * Runs a PR's tests from the sidecar, inside a macOS Seatbelt sandbox.
 *
 * The user has already agreed to run this PR's code, and its setup script runs
 * unsandboxed, so this is defence in depth rather than the trust boundary. It
 * is still made as tight as test runners tolerate. Claude Code's sandbox only
 * wraps the commands Claude Code runs; mutation testing runs the tests itself,
 * under `sandbox-exec` with a deny-by-default profile that allows:
 *  - running programs, and signalling or inspecting only processes in the same
 *    sandbox — but not `setsid`, so nothing it starts can leave the session
 *    the sweep looks in (see `SandboxSession.sweep`);
 *  - reading the system and the toolchains, but nothing else in the home
 *    directory, no other run's temp folder, and no other review checkout or
 *    clone;
 *  - writing only to the scratch copy, the run's temp folder and a few
 *    devices; no terminals;
 *  - a short, vetted list of system services (logging, preferences, user and
 *    group lookup, temp-folder resolution, certificate trust) — not
 *    LaunchServices, launchd job submission, the keychain, Apple events,
 *    FSEvents or notifications;
 *  - loopback networking only: connecting only to the ephemeral port range
 *    (where a server a test starts on port 0 lands), binding anywhere on
 *    loopback but the ports of local services, and Unix sockets only inside
 *    the copy and temp folder. DNS is refused, since a lookup is a way out on
 *    its own.
 * The tests get a fake `HOME` in the temp folder, with tool caches pointed
 * there too and toolchain locations passed explicitly. There is no fallback:
 * where the sandbox can't be applied, or its startup check finds a gap, no test
 * runs (`SandboxUnavailableError`).
 *
 * Compiling the profile takes about three seconds (it lists every ephemeral
 * port), so a pass pays it once: `openSandboxSession` starts one small helper
 * under `sandbox-exec` and runs every command as the helper's child, which
 * inherits the sandbox. Commands are argv, never a shell line, with no
 * provider secrets or SSH agent, each in its own process group.
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
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
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

/**
 * How long past its deadline (or its cancel) a command's exit may take to be
 * reported before the helper is presumed stuck and the session is torn down.
 */
const WATCHDOG_SLACK_MS = KILL_GRACE_MS + EXIT_GRACE_MS + 3_000;

/** How often a running command's process tree is sampled for the sweep. */
const MEMBERSHIP_POLL_MS = 100;

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
  "writes only to a scratch copy and a temp folder, and no reads of your home folder beyond the " +
  "toolchains, or of other checkouts. It is a second line of defence, not a guarantee: agreeing to " +
  "run this pull request's code means trusting it, and its setup script runs without a sandbox.";

/**
 * Home-directory folders toolchains are installed in or read from, and the
 * only parts of the home directory a test may read. Anything on `PATH` under
 * the home directory is added to these.
 */
const TOOLCHAIN_HOME_PATHS = [
  ".local/bin",
  ".local/lib",
  ".local/share/mise",
  ".local/share/pnpm",
  ".config/mise",
  ".cargo",
  ".rustup",
  "go",
  "sdk",
  ".nvm",
  ".volta",
  ".bun",
  ".deno",
  ".pyenv",
  ".rbenv",
  ".rvm",
  ".gem",
  ".asdf",
  ".sdkman",
  ".m2/repository",
  ".gradle/caches",
  ".gradle/wrapper",
  "Library/Python",
  "Library/pnpm",
];

/**
 * Inside the toolchain folders, files that hold credentials. Denied again after
 * the folders are allowed.
 */
const TOOLCHAIN_SECRETS = [".cargo/credentials", ".cargo/credentials.toml", ".gem/credentials"];

/**
 * Loopback ports a test may connect to: macOS's ephemeral range
 * (`net.inet.ip.portrange.first`/`last`), where a server bound to port 0 lands.
 * Seatbelt can't deny one outbound port out of an allowed wildcard (an
 * outbound deny after a loopback allow is ignored; checked), nor express a
 * range, so the range is listed port by port. A test that connects to a fixed
 * port of its own fails its baseline and says so.
 */
const EPHEMERAL_PORTS = { first: 49152, last: 65535 };
/** Filters per rule: one rule holding all of them fails to compile. */
const PORTS_PER_RULE = 1_000;

/**
 * Local service ports a test may not bind, so it can't pose as one of them to
 * the sidecar or anything else on this machine. A second port list the size of
 * the ephemeral one doesn't fit in a profile (`sandbox_apply` refuses it), but
 * a bind deny after a loopback allow does hold (checked; an inbound deny
 * doesn't), so binding is allowed on loopback minus these and every
 * privileged port. Port 0 still works: the kernel picks an ephemeral port.
 */
const SERVICE_PORTS = [
  1080, 2375, 2376, 3306, 4317, 4318, 5000, 5432, 5433, 5672, 5900, 6379, 6443, 7000, 8200, 8500,
  8765, 9050, 9200, 9300, 11211, 11434, 15672, 27017,
];

/**
 * System services a test runner may look up: local plumbing only — logging,
 * preferences, user and group lookups, temp-folder resolution, certificate
 * trust. LaunchServices, launchd job submission, the keychain
 * (`com.apple.SecurityServer`), Apple events, the pasteboard, FSEvents and the
 * notification center are absent; the toolchains here run without them
 * (checked with bun, node, jest, vitest, pytest and go).
 */
const MACH_SERVICES = [
  "com.apple.system.logger",
  "com.apple.logd",
  "com.apple.diagnosticd",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.system.DirectoryService.libinfo_v1",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
  "com.apple.bsd.dirhelper",
  "com.apple.trustd",
  "com.apple.trustd.agent",
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

/** `/a/b/c` → `/`, `/a`, `/a/b`: what a process stats on the way to `/a/b/c`. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    out.push(dir);
    if (dir === dirname(dir)) return out;
  }
}

/** Where things are, for building a profile; tests supply their own. */
export interface SandboxPaths {
  /** The scratch copy; the tests' working directory. */
  copy: string;
  /** The run's temp folder; also holds the fake home. */
  tempDir: string;
  /** The user's real home, of which only the toolchains are readable. */
  realHome: string;
  /** Review checkouts and clones live here; all but the copy are denied. */
  workspacesRoot: string;
  /**
   * Ports to keep out of reach even inside the ephemeral range: the database
   * and the sidecar, should either be configured there.
   */
  extraBlockedPorts: number[];
  /** The system temp folder, whose other contents (other runs') are denied. */
  systemTemp?: string;
  /** Searched for toolchain folders under the home directory; defaults to this process's `PATH`. */
  path?: string;
}

/** The home-directory folders a test may read: the toolchains, and what's on PATH. */
export function readableHomePaths(home: string, path = process.env.PATH ?? ""): string[] {
  const fromPath = path
    .split(delimiter)
    .filter((dir) => dir.startsWith(`${home}${sep}`))
    .map((dir) => realpathOr(dir));
  return [...new Set([...TOOLCHAIN_HOME_PATHS.map((p) => join(home, p)), ...fromPath])].filter(
    (dir) => dir !== home && !dir.split(sep).some((part) => part === ".ssh" || part === ".aws"),
  );
}

/**
 * The profile for one run. Every path is a realpath, since Seatbelt matches
 * the resolved path (`/private/var/…`, not `/var/…`). Later rules win, which
 * is how the toolchains, copy and temp folder stay readable inside denied
 * folders, and the toolchains' own credential files are denied again.
 */
export function sandboxProfile(paths: SandboxPaths): string {
  const copy = realpathSync(paths.copy);
  const temp = realpathSync(paths.tempDir);
  const home = realpathOr(paths.realHome);
  const root = realpathOr(paths.workspacesRoot);
  const systemTemp = realpathOr(paths.systemTemp ?? tmpdir());
  const sub = (path: string) => `(subpath ${sbString(path)})`;
  const lit = (path: string) => `(literal ${sbString(path)})`;

  const toolchains = readableHomePaths(home, paths.path);
  const deniedReads = [
    sub(home),
    sub(systemTemp),
    '(regex #"^/private/tmp/claude-")',
    sub(join(root, ".review")),
    sub(join(root, ".review-repos")),
    '(regex #"^/dev/(ttys|pty)")',
  ];
  const secrets = [
    ...SECRET_HOME_PATHS.map((p) => join(home, p)),
    ...TOOLCHAIN_SECRETS.map((p) => join(home, p)),
    join(home, ".yarvis"),
    join(home, "Library", "Application Support", APP_IDENTIFIER),
  ];
  // Stat-ing the way down to the copy, the temp folder and the toolchains has
  // to work, or `realpath` (and every runtime that calls it) fails.
  const metadata = [
    ...new Set([copy, temp, ...toolchains].flatMap((path) => [path, ...ancestors(path)])),
  ];

  const blocked = new Set(paths.extraBlockedPorts);
  const ports: number[] = [];
  for (let port = EPHEMERAL_PORTS.first; port <= EPHEMERAL_PORTS.last; port++) {
    if (!blocked.has(port)) ports.push(port);
  }
  const outboundRules: string[] = [];
  for (let i = 0; i < ports.length; i += PORTS_PER_RULE) {
    const filters = ports
      .slice(i, i + PORTS_PER_RULE)
      .map((port) => `(remote ip "localhost:${port}")`);
    outboundRules.push(`(allow network-outbound ${filters.join(" ")})`);
  }
  const noListen: number[] = [];
  for (let port = 1; port < 1024; port++) noListen.push(port);
  noListen.push(...SERVICE_PORTS, ...paths.extraBlockedPorts);
  const listenDeny = [...new Set(noListen)].map((port) => `(local ip "localhost:${port}")`);

  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    // Without setsid, everything a test starts stays in the helper's session.
    "(deny syscall-unix (syscall-number SYS_setsid))",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow system-socket)",
    "(allow file-map-executable)",
    "(allow ipc-posix-sem*)",
    "(allow ipc-posix-shm*)",
    `(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name ${sbString(name)})`).join(" ")})`,
    "(allow file-read*)",
    `(deny file-read* ${deniedReads.join(" ")})`,
    `(allow file-read* ${toolchains.map(sub).join(" ")})`,
    `(deny file-read* ${secrets.map(sub).join(" ")})`,
    `(allow file-read* ${sub(copy)} ${sub(temp)})`,
    `(allow file-read-metadata ${metadata.map(lit).join(" ")})`,
    `(allow file-write* ${sub(copy)} ${sub(temp)} ${[
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/dtracehelper")',
      '(regex #"^/dev/fd/")',
    ].join(" ")})`,
    '(deny file-write* (regex #"^/dev/(ttys|pty)"))',
    `(allow file-ioctl ${[
      "/dev/null",
      "/dev/zero",
      "/dev/random",
      "/dev/urandom",
      "/dev/dtracehelper",
    ]
      .map(lit)
      .join(" ")})`,
    // A hard link inside the copy to a file outside it would make that file
    // writable through the copy's path.
    "(deny file-link)",
    '(allow network-bind (local ip "localhost:*"))',
    `(deny network-bind ${listenDeny.join(" ")})`,
    '(allow network-inbound (local ip "localhost:*"))',
    ...outboundRules,
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

function signalQuietly(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch {
    // Already gone.
  }
}

/** Signals a process group and its leader: the leader may have moved to another group. */
function killGroup(pgid: number, signal: NodeJS.Signals): void {
  signalQuietly(-pgid, signal);
  signalQuietly(pgid, signal);
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
sub reply { print $json->encode($_[0]), "\n"; }
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
    chdir $cwd or do { print STDERR "cannot enter $cwd: $!\n"; POSIX::_exit(126); };
    { no warnings; exec { $argv->[0] } @$argv; }
    print STDERR "cannot run $argv->[0]: $!\n";
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

interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  /** `ps`'s start time, so a reused pid is never mistaken for a member. */
  started: string;
}

function listProcesses(): Promise<ProcessEntry[]> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,lstart="],
      { maxBuffer: 16 * 1024 * 1024 },
      (_e, out) => {
        resolve(
          (out ?? "")
            .split("\n")
            .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
            .filter((m): m is RegExpExecArray => m !== null)
            .map((m) => ({
              pid: Number(m[1]),
              ppid: Number(m[2]),
              pgid: Number(m[3]),
              started: m[4] as string,
            })),
        );
      },
    );
  });
}

/** Pids of this user's processes whose environment names `marker` (`ps -E`). */
function processesWithEnv(marker: string): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-E", "-ww", "-x", "-o", "pid=,command="],
      { maxBuffer: 64 * 1024 * 1024 },
      (_e, out) => {
        resolve(
          (out ?? "")
            .split("\n")
            .filter((line) => line.includes(marker))
            .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1]))
            .filter((pid) => Number.isInteger(pid) && pid > 0),
        );
      },
    );
  });
}

export interface SandboxSession {
  /** Runs commands through the session's helper; every command must use the session's copy and temp folder. */
  runner: SandboxRunner;
  /** The helper's pid, which the stray sweep must spare. */
  helperPid: number | undefined;
  /**
   * Kills every process the sandbox started that is still running, and checks
   * again: returns the pids killed. See the comment inside for how they are found.
   */
  sweep: () => Promise<number[]>;
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
    return { runner: runSandboxed, helperPid: undefined, sweep: async () => [], close: () => {} };
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
      // Its own session and group: everything it starts stays in that session,
      // since the profile refuses setsid.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    removeProfile();
    throw e;
  }
  const helperPid = helper.pid;
  if (helperPid !== undefined) liveGroups.add(helperPid);

  /**
   * Every process the helper's commands started, by pid and start time. Found
   * three ways, since no one way catches them all: the process tree (parent
   * and group links, sampled while commands run, so a child that is reparented
   * after its parent exits was usually seen first); the environment, which
   * names this run's temp folder unless a process cleared it; and, in the
   * executor's sweep, anything working in or run from the copy or temp folder.
   * A process can't leave the session (no setsid), but a session can't be
   * listed on macOS, so it is these that find it. All of them are still
   * sandboxed: what this catches can't write outside the copy and temp folder.
   */
  const members = new Map<number, string>();
  const scan = async () => {
    if (helperPid === undefined) return;
    const processes = await listProcesses();
    const byPid = new Map(processes.map((p) => [p.pid, p]));
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of processes) {
        if (p.pid === helperPid || members.get(p.pid) === p.started) continue;
        const parentKnown = p.ppid === helperPid || members.has(p.ppid);
        const groupKnown =
          members.has(p.pgid) && byPid.get(p.pgid)?.started === members.get(p.pgid);
        if (parentKnown || groupKnown) {
          members.set(p.pid, p.started);
          grew = true;
        }
      }
    }
  };
  let polling: ReturnType<typeof setInterval> | undefined;
  let running = 0;
  const startPolling = () => {
    running++;
    polling ??= setInterval(() => void scan(), MEMBERSHIP_POLL_MS);
  };
  const stopPolling = () => {
    running = Math.max(0, running - 1);
    if (running === 0 && polling) {
      clearInterval(polling);
      polling = undefined;
    }
  };

  const killMembers = async (): Promise<number[]> => {
    await scan();
    const byEnv = await processesWithEnv(realpathOr(base.tempDir));
    const current = new Map((await listProcesses()).map((p) => [p.pid, p.started]));
    for (const pid of byEnv) {
      const started = current.get(pid);
      if (started && pid !== helperPid && pid !== process.pid) members.set(pid, started);
    }
    const killed: number[] = [];
    for (const [pid, started] of members) {
      if (current.get(pid) !== started) {
        members.delete(pid);
        continue;
      }
      signalQuietly(pid, "SIGKILL");
      killed.push(pid);
    }
    return killed;
  };

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
  // A helper that died mid-write closes the pipe under us; the exit handler reports it.
  helper.stdin?.on("error", () => {});
  const fail = (message: string) => {
    broken ??= message;
    for (const entry of pending.values()) entry.onError(broken);
    pending.clear();
  };
  /** Tears the session down: the helper, its group and everything it started. */
  const breakSession = (message: string) => {
    if (helperPid !== undefined) killGroup(helperPid, "SIGKILL");
    void killMembers();
    fail(message);
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
    startPolling();
    return new Promise<SandboxedRun>((resolve, reject) => {
      let pgid: number | undefined;
      let timedOut = false;
      let aborted = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog = (ms: number) => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          breakSession("the sandbox helper stopped answering, so the session was ended");
        }, ms);
      };
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
      armWatchdog(command.timeoutMs + WATCHDOG_SLACK_MS);
      const onAbort = () => {
        aborted = true;
        stop();
        armWatchdog(WATCHDOG_SLACK_MS);
      };
      const settle = () => {
        clearTimeout(timer);
        if (watchdog) clearTimeout(watchdog);
        if (forceKill) clearTimeout(forceKill);
        command.signal.removeEventListener("abort", onAbort);
        stopPolling();
        if (pgid !== undefined) {
          // Whatever the command left running in its group goes with it.
          killGroup(pgid, "SIGKILL");
          liveGroups.delete(pgid);
        }
      };
      pending.set(id, {
        onSpawned: (spawned) => {
          pgid = spawned;
          members.set(spawned, "");
          liveGroups.add(spawned);
          command.onSpawn?.(spawned);
          // Records its real start time, and catches what it starts right away.
          void scan();
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
    sweep: killMembers,
    close: () => {
      helper.stdin?.end();
      if (polling) clearInterval(polling);
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
 * left behind outside its process group. Returns the pids it killed. Never
 * this process or `spare`. A session's own sweep (`SandboxSession.sweep`)
 * finds what has moved elsewhere.
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
  for (const pid of pids) signalQuietly(pid, "SIGKILL");
  return [...pids];
}

/** The startup check's probes, run as one script so the profile compiles once. */
const PROBE_SCRIPT = String.raw`
probe() { name=$1; shift; out=$("$@" 2>&1); code=$?; printf '@@%s|%s|%s\n' "$name" "$code" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-400)"; }
outside_write=$1; outside_target=$2; secret=$3; tag=$4; private=$5; listen_port=$6; shift 6
probe write /bin/sh -c 'echo escaped > "$1"' sh "$outside_write"
probe link /bin/sh -c 'ln "$1" link-probe && echo escaped >> link-probe' sh "$outside_target"
probe secret /bin/ls "$secret"
probe private /bin/cat "$private"
probe tty /bin/sh -c ': > /dev/ttys000'
probe network /usr/bin/nc -v -z -G 2 192.0.2.1 443
for port in "$@"; do probe "service$port" /usr/bin/nc -v -z -G 1 127.0.0.1 "$port"; done
probe listen /usr/bin/perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => $ARGV[0], Listen => 1, ReuseAddr => 1) or die "listen: $!\n"; print "listening\n"' "$listen_port"
probe dns /usr/bin/dscacheutil -q host -a name example.com
probe unix /usr/bin/nc -U -z /private/var/run/mDNSResponder
probe launchd /bin/launchctl submit -l "$tag" -- /usr/bin/true
probe launchservices /usr/bin/lsappinfo front
probe keychain /usr/bin/security show-keychain-info /Library/Keychains/System.keychain
probe setsid /usr/bin/perl -MPOSIX -e 'print((POSIX::setsid() // -1) > 0 ? "new session\n" : "setsid: $!\n")'
`;

const REFUSED = "Operation not permitted";

/** A blocked service port nothing is listening on, so a listen probe can tell refusal from "in use". */
function freeServicePort(): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
  return (async () => {
    for (const port of SERVICE_PORTS) if (await tryPort(port)) return port;
    return SERVICE_PORTS[0] as number;
  })();
}

/**
 * Checks, before any test runs, that the sandbox applies and holds. One
 * sandboxed script tries each of these, and every one must be refused: a
 * write next to the copy; a hard link to a file outside it, written through;
 * a read of a credential folder and of a private file in the real home; a
 * terminal; an outbound connection; a connection to every blocked port; a
 * listen on a service port; a DNS lookup; a Unix socket outside the copy;
 * submitting a launchd job; a LaunchServices query; a keychain query; setsid.
 * A probe that reports nothing counts as one that got through. A sandbox that
 * can't be applied (a nested one, say) fails here rather than letting a test
 * run outside it.
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
  // Present on every Mac, and private to the user: the home directory beyond
  // the toolchains must be unreadable, whatever HOME says.
  const privateFile =
    [
      join(realHome, "Library", "Preferences", ".GlobalPreferences.plist"),
      join(realHome, ".zsh_history"),
    ].find((p) => existsSync(p)) ??
    join(realHome, "Library", "Preferences", ".GlobalPreferences.plist");
  const blockedPorts = [
    ...new Set([
      ...(sandbox?.extraBlockedPorts ?? sandboxDefaults.extraBlockedPorts),
      5432,
      6379,
      11434,
    ]),
  ];
  const listenPort = await freeServicePort();

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
        privateFile,
        String(listenPort),
        ...blockedPorts.map(String),
      ],
      cwd: dirs.cwd,
      tempDir: dirs.tempDir,
      timeoutMs: 60_000,
      signal,
      sandbox,
    });
    if (signal.aborted || run.aborted) return;
    const results = new Map<string, { code: number; out: string }>();
    for (const match of run.output.matchAll(/^@@([a-z0-9]+)\|(\d+)\|(.*)$/gm)) {
      results.set(match[1] as string, { code: Number(match[2]), out: match[3] ?? "" });
    }
    const refused = (name: string) => results.get(name)?.out.includes(REFUSED) === true;
    const reported = (name: string) => results.has(name);
    const escaped: [string, boolean][] = [
      ["a write outside the copy", existsSync(outsideWrite) || !reported("write")],
      [
        "a hard link to a file outside the copy",
        !readFileSync(outsideTarget, "utf8").startsWith("untouched") || !reported("link"),
      ],
      ["a read of a credential folder", !refused("secret")],
      ["a read of a private file in the home folder", !refused("private")],
      ["opening a terminal", !refused("tty")],
      ["an outbound connection", !refused("network")],
      ...blockedPorts.map((port): [string, boolean] => [
        `a connection to port ${port}`,
        !refused(`service${port}`),
      ]),
      [`listening on port ${listenPort}`, !refused("listen")],
      [
        "a DNS lookup",
        !reported("dns") || /ip_address|ipv6_address/.test(results.get("dns")?.out ?? ""),
      ],
      ["a Unix socket outside the copy", !reported("unix") || results.get("unix")?.code === 0],
      ["submitting a launchd job", !reported("launchd") || results.get("launchd")?.code === 0],
      [
        "a LaunchServices query",
        !reported("launchservices") || /ASN:/.test(results.get("launchservices")?.out ?? ""),
      ],
      [
        "a keychain query",
        !reported("keychain") ||
          /lock-on-sleep|no-timeout|timeout=/.test(results.get("keychain")?.out ?? ""),
      ],
      ["leaving the session (setsid)", !refused("setsid")],
    ];
    if (results.get("launchd")?.code === 0) execFile("/bin/launchctl", ["remove", tag], () => {});
    const gap = escaped.find(([, through]) => through);
    if (gap) throw new SandboxUnavailableError(`${gap[0]} was not refused`);
  } finally {
    rmSync(outsideWrite, { force: true });
    rmSync(outsideTarget, { force: true });
    rmSync(join(dirs.cwd, "link-probe"), { force: true });
  }
}
