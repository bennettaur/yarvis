import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { TurnDetector, type TurnDetectorDeps } from "./turnDetector.ts";

/** A child process that only exits or prints when the test says so. */
let nextPid = 100;
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: nextPid++,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return child;
}

let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.YARVIS_SIDECAR_TOKEN;
  process.env.YARVIS_SIDECAR_TOKEN = "sidecar-secret";
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.YARVIS_SIDECAR_TOKEN;
  else process.env.YARVIS_SIDECAR_TOKEN = originalToken;
});

function detector(overrides: Partial<TurnDetectorDeps> = {}) {
  const killed: number[] = [];
  const spawned: {
    program: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    child: ChildProcess;
  }[] = [];
  const deps: TurnDetectorDeps = {
    spawn: (program, args, env) => {
      const child = fakeChild();
      spawned.push({ program, args, env, child });
      return child;
    },
    writeScript: () => "/tmp/turn_server.py",
    newToken: () => "tok en",
    kill: (pid) => killed.push(pid),
    startTimeoutMs: 60_000,
    ...overrides,
  };
  return { detector: new TurnDetector(deps), spawned, killed };
}

describe("TurnDetector", () => {
  it("runs the embedded script with uv and hands the server its token, and nothing else secret", () => {
    const { detector: turns, spawned } = detector();
    expect(turns.start().state).toBe("starting");

    expect(spawned[0]?.program).toBe("uv");
    expect(spawned[0]?.args).toEqual(["run", "--quiet", "--script", "/tmp/turn_server.py"]);
    expect(spawned[0]?.env.YARVIS_TURN_TOKEN).toBe("tok en");
    // The sidecar's own bearer would open the whole loopback API to the child.
    expect(spawned[0]?.env.YARVIS_SIDECAR_TOKEN).toBeUndefined();
  });

  it("reports the websocket URL once the server says it is listening", () => {
    const { detector: turns, spawned } = detector();
    turns.start();
    const stdout = spawned[0]?.child.stdout as EventEmitter;

    stdout.emit("data", "Installed 22 packages\nYARVIS_TURN_");
    expect(turns.status().state).toBe("starting");
    // The ready line can arrive split across chunks.
    stdout.emit("data", "READY 5123\n");

    const status = turns.status();
    expect(status.state).toBe("running");
    expect(status.url).toBe("ws://127.0.0.1:5123/?token=tok%20en");
    expect(status.log).toEqual(["Installed 22 packages"]);
  });

  it("starts one server however many chats ask", () => {
    const { detector: turns, spawned } = detector();
    turns.start();
    turns.start();
    expect(spawned).toHaveLength(1);
  });

  it("reports a server that exits, and starts a fresh one on the next request", () => {
    const { detector: turns, spawned } = detector();
    turns.start();
    spawned[0]?.child.emit("exit", 1, null);

    const failed = turns.status();
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/exited \(code 1\)/);
    expect(failed.url).toBeNull();

    turns.start();
    expect(spawned).toHaveLength(2);
  });

  it("says how to install uv when it is missing", () => {
    const { detector: turns, spawned } = detector();
    turns.start();
    spawned[0]?.child.emit(
      "error",
      Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" }),
    );

    expect(turns.status().error).toMatch(/brew install uv/);
  });

  it("uses a new token for each server", () => {
    let n = 0;
    const { detector: turns, spawned } = detector({ newToken: () => `token-${++n}` });
    turns.start();
    spawned[0]?.child.emit("exit", 1, null);
    turns.start();
    expect(spawned.map((s) => s.env.YARVIS_TURN_TOKEN)).toEqual(["token-1", "token-2"]);
  });

  it("ignores a replaced server's exit and ready line", () => {
    const { detector: turns, spawned } = detector();
    turns.start();
    spawned[0]?.child.emit("exit", 1, null);
    turns.start();

    spawned[0]?.child.emit("exit", 0, null);
    const replaced = spawned[0]?.child.stdout as EventEmitter;
    replaced.emit("data", "YARVIS_TURN_READY 9999\n");

    expect(turns.status().state).toBe("starting");
  });

  it("reports a script it couldn't write without starting anything", () => {
    const { detector: turns, spawned } = detector({
      writeScript: () => {
        throw new Error("read-only file system");
      },
    });
    const status = turns.start();
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/read-only file system/);
    expect(spawned).toHaveLength(0);
  });

  it("keeps stderr lines whole when they arrive in pieces", () => {
    const { detector: turns, spawned } = detector();
    turns.start();
    const stderr = spawned[0]?.child.stderr as EventEmitter;
    stderr.emit("data", "Traceback (most re");
    stderr.emit("data", "cent call last):\n");
    expect(turns.status().log).toEqual(["Traceback (most recent call last):"]);
  });

  it("keeps an exited server's last lines, but not a replaced one's", () => {
    const { detector: turns, spawned } = detector();
    turns.start();
    const first = spawned[0]?.child.stderr as EventEmitter;
    spawned[0]?.child.emit("exit", 1, null);
    first.emit("data", "ModuleNotFoundError: onnxruntime\n");
    expect(turns.status().log).toEqual(["ModuleNotFoundError: onnxruntime"]);

    turns.start();
    first.emit("data", "late line\n");
    (spawned[0]!.child.stdout as EventEmitter).emit("data", "late stdout\n");
    (spawned[1]!.child.stderr as EventEmitter).emit("data", "Downloading model\n");
    expect(turns.status().log).toEqual(["Downloading model"]);
  });

  it("kills a start that never becomes ready and lets the next request retry", async () => {
    const { detector: turns, spawned, killed } = detector({ startTimeoutMs: 20 });
    turns.start();
    await Bun.sleep(40);

    const status = turns.status();
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/didn't start in time/);
    expect(killed).toEqual([spawned[0]?.child.pid as number]);

    turns.start();
    expect(spawned).toHaveLength(2);
  });
});

describe("the embedded server script", () => {
  it("is the turn server, pinned to fixed model revisions", async () => {
    const script = await readFile(new URL("./turn_server.py", import.meta.url), "utf8");
    expect(script).toContain("YARVIS_TURN_READY");
    expect(script).toMatch(/SILERO_REVISION = "[0-9a-f]{40}"/);
    expect(script).toMatch(/SMART_TURN_REVISION = "[0-9a-f]{40}"/);
  });
});
