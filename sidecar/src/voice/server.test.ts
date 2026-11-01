import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { listCustomProviders } from "../customProviders/service.ts";
import { createVoiceRoutes } from "./routes.ts";
import { assertHubModelId, LocalSpeechServer, type SpeechServerDeps } from "./server.ts";

/** A child process that only exits when the test says so. */
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter() });
  return child;
}

let dir: string;
let originalSettings: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-speech-server-"));
  originalSettings = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalSettings === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettings;
  await rm(dir, { recursive: true, force: true });
});

function manager(overrides: Partial<SpeechServerDeps> = {}) {
  const spawned: { program: string; args: string[]; child: ChildProcess }[] = [];
  const deps: SpeechServerDeps = {
    spawn: (program, args) => {
      const child = fakeChild();
      spawned.push({ program, args, child });
      return child;
    },
    probe: async () => false,
    hubCacheDir: () => join(dir, "hub"),
    processStartTime: async () => null,
    listenerCommand: async () => null,
    instance: "main",
    ...overrides,
  };
  return { server: new LocalSpeechServer(deps), spawned };
}

describe("LocalSpeechServer", () => {
  it("starts mlx-audio on loopback through uvx", async () => {
    const { server, spawned } = manager();
    const status = await server.start();
    expect(status.state).toBe("starting");
    expect(spawned[0]?.program).toBe("uvx");
    const args = spawned[0]?.args ?? [];
    expect(args).toContain("mlx_audio.server");
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    // mlx-audio's own default is every origin, which lets any web page drive it.
    expect(args[args.indexOf("--allowed-origins") + 1]).toBe("http://127.0.0.1:8000");
  });

  it("spawns one server for overlapping start requests", async () => {
    const { server, spawned } = manager();
    await Promise.all([server.start(), server.start()]);
    expect(spawned).toHaveLength(1);
  });

  /** Starts a server as `instance` whose process is `pid`, started at `startedAt`. */
  async function startedBy(instance: string, pid: number, startedAt: string | null): Promise<void> {
    const child = fakeChild();
    Object.assign(child, { pid });
    await new LocalSpeechServer({
      probe: async () => false,
      hubCacheDir: () => join(dir, "hub"),
      spawn: () => child,
      processStartTime: async () => startedAt,
      listenerCommand: async () => null,
      instance,
    }).start();
  }

  // Pids that are not running: a stray kill is a no-op either way.
  const pid = 2_147_483_000;

  it("adopts a server an earlier sidecar of the same instance started, so it can still be stopped", async () => {
    await startedBy("main", pid, "Mon Nov  2 09:00:00 2026");

    let alive = true;
    const next = manager({
      probe: async () => alive,
      processStartTime: async (p) => (alive && p === pid ? "Mon Nov  2 09:00:00 2026" : null),
    });
    expect((await next.server.status()).state).toBe("running");
    expect((await next.server.start()).state).toBe("running");
    expect(next.spawned).toHaveLength(0);

    const stopping = next.server.stop();
    alive = false;
    expect((await stopping).state).toBe("stopped");
  });

  it("shows another instance's server as theirs and leaves it running on stop", async () => {
    await startedBy("work", pid, "Mon Nov  2 09:00:00 2026");
    const kills: number[] = [];
    const originalKill = process.kill;
    process.kill = ((target: number) => {
      kills.push(target);
      return true;
    }) as typeof process.kill;
    try {
      const other = manager({
        probe: async () => true,
        processStartTime: async () => "Mon Nov  2 09:00:00 2026",
      });
      const status = await other.server.status();
      expect(status).toMatchObject({ state: "external", owner: "work" });
      expect((await other.server.stop()).state).toBe("external");
      expect(kills).toHaveLength(0);
    } finally {
      process.kill = originalKill;
    }
  });

  async function records(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(join(dir, "speech-server.json"), "utf8"));
    } catch {
      return {};
    }
  }

  it("keeps a record it couldn't time at spawn, without trusting it, until the process is gone", async () => {
    await startedBy("main", pid, null);
    let alive = true;
    const next = manager({
      processStartTime: async () => (alive ? "Mon Nov  2 09:00:00 2026" : null),
    });
    expect((await next.server.status()).state).toBe("stopped");
    expect(Object.keys(await records())).toEqual(["main"]);

    alive = false;
    await next.server.status();
    expect(await records()).toEqual({});
  });

  it("reports a server that exits while its pid is being recorded", async () => {
    const child = fakeChild();
    Object.assign(child, { pid });
    const server = new LocalSpeechServer({
      probe: async () => false,
      hubCacheDir: () => join(dir, "hub"),
      spawn: () => child,
      processStartTime: async () => {
        child.emit("exit", 1, null);
        return "Mon Nov  2 09:00:00 2026";
      },
      listenerCommand: async () => null,
      instance: "main",
    });
    expect((await server.start()).state).toBe("failed");
    expect(await records()).toEqual({});
  });

  describe("record lock", () => {
    const lock = () => join(dir, "speech-server.json.lock");
    const work = { pid: 123, port: 9000, startedAt: "Mon Nov  2 08:00:00 2026" };

    it("waits for another instance's update instead of writing over it", async () => {
      await writeFile(join(dir, "speech-server.json"), JSON.stringify({ work }));
      await writeFile(lock(), "");
      // Another instance holds the lock briefly, then lets go.
      const other = Bun.spawn(["sh", "-c", `sleep 0.3; rm -f '${lock()}'`]);
      await startedBy("main", pid, "Mon Nov  2 09:00:00 2026");
      await other.exited;
      expect(Object.keys(await records()).sort()).toEqual(["main", "work"]);
      expect(existsSync(lock())).toBe(false);
    });

    it("takes over a lock a crashed instance left behind", async () => {
      await writeFile(lock(), "");
      const old = new Date(Date.now() - 60_000);
      await utimes(lock(), old, old);
      await startedBy("main", pid, "Mon Nov  2 09:00:00 2026");
      expect(Object.keys(await records())).toEqual(["main"]);
      expect(existsSync(lock())).toBe(false);
    });

    it("gives up, leaving the file and the other instance's lock alone, when the lock stays held", async () => {
      await writeFile(join(dir, "speech-server.json"), JSON.stringify({ work }));
      await writeFile(lock(), "");
      await startedBy("main", pid, "Mon Nov  2 09:00:00 2026");
      expect(Object.keys(await records())).toEqual(["work"]);
      expect(existsSync(lock())).toBe(true);
    });
  });

  it("does not adopt a process that reused the recorded pid", async () => {
    await startedBy("main", pid, "Mon Nov  2 09:00:00 2026");
    const next = manager({ processStartTime: async () => "Tue Nov  3 10:00:00 2026" });
    expect((await next.server.status()).state).toBe("stopped");
    await next.server.start();
    expect(next.spawned).toHaveLength(1);
  });

  it("uses an mlx-audio server already on the port rather than starting a second one", async () => {
    const { server, spawned } = manager({
      probe: async () => true,
      listenerCommand: async () => "/usr/bin/python3 -m mlx_audio.server --port 8000",
    });
    expect(await server.start()).toMatchObject({ state: "external", owner: null });
    expect(spawned).toHaveLength(0);
  });

  it("refuses a port some other program answers on", async () => {
    const { server, spawned } = manager({
      probe: async () => true,
      listenerCommand: async () => "node vite --port 8000",
    });
    expect((await server.start()).state).toBe("occupied");
    expect(spawned).toHaveLength(0);
  });

  it("reports a crash with the server's own output kept", async () => {
    const { server, spawned } = manager();
    await server.start();
    const child = spawned[0]?.child as ChildProcess;
    child.stderr?.emit("data", Buffer.from("ImportError: no module\n"));
    child.emit("exit", 1, null);
    const status = await server.status();
    expect(status.state).toBe("failed");
    expect(status.log).toContain("ImportError: no module");
  });

  it("says to install uv when uvx is missing", async () => {
    const { server, spawned } = manager();
    await server.start();
    const error = Object.assign(new Error("spawn uvx ENOENT"), { code: "ENOENT" });
    spawned[0]?.child.emit("error", error);
    expect((await server.status()).error).toContain("brew install uv");
  });

  it("marks a model downloaded when the hub cache holds it", async () => {
    await mkdir(
      join(dir, "hub", "models--mlx-community--Soprano-1.1-80M-bf16", "snapshots", "abc"),
      {
        recursive: true,
      },
    );
    const { server } = manager();
    const soprano = server.models().find((m) => m.id === "mlx-community/Soprano-1.1-80M-bf16");
    expect(soprano?.state).toBe("downloaded");
  });

  it("does not count a model whose download left only an empty folder", async () => {
    await mkdir(join(dir, "hub", "models--mlx-community--Kokoro-82M-bf16"), { recursive: true });
    const { server } = manager();
    const kokoro = server.models().find((m) => m.id === "mlx-community/Kokoro-82M-bf16");
    expect(kokoro?.state).toBe("absent");
  });

  it("tracks a download until the child exits", () => {
    const { server, spawned } = manager();
    expect(server.download("mlx-community/Kokoro-82M-bf16").state).toBe("downloading");
    expect(spawned[0]?.args).toEqual([
      "--from",
      "huggingface_hub",
      "hf",
      "download",
      "mlx-community/Kokoro-82M-bf16",
    ]);
    spawned[0]?.child.emit("exit", 1, null);
    const kokoro = server.models().find((m) => m.id === "mlx-community/Kokoro-82M-bf16");
    expect(kokoro?.state).toBe("failed");
  });

  it("registers one provider for the server, however often it is asked", async () => {
    const { server } = manager();
    const first = await server.ensureProvider(8000);
    const second = await server.ensureProvider(8000);
    expect(second).toBe(first);
    expect(await listCustomProviders()).toHaveLength(1);
  });
});

describe("speech server routes", () => {
  it("won't register a port some other program answers on as the speech provider", async () => {
    const { server } = manager({
      probe: async () => true,
      listenerCommand: async () => "node vite --port 8000",
    });
    const routes = createVoiceRoutes({} as Config, { server });
    const res = await routes.request("/server/provider", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await listCustomProviders()).toHaveLength(0);
  });
});

describe("speech server routes, continued", () => {
  it("won't register a port nothing is serving", async () => {
    const { server } = manager();
    const routes = createVoiceRoutes({} as Config, { server });
    expect((await routes.request("/server/provider", { method: "POST" })).status).toBe(409);
    expect(await listCustomProviders()).toHaveLength(0);
  });

  it("registers the port mlx-audio is running on", async () => {
    const { server } = manager({
      probe: async () => true,
      listenerCommand: async () => "python -m mlx_audio.server --port 8000",
    });
    const routes = createVoiceRoutes({} as Config, { server });
    expect((await routes.request("/server/provider", { method: "POST" })).status).toBe(200);
    expect((await listCustomProviders())[0]?.baseUrl).toBe("http://127.0.0.1:8000/v1");
  });

  it("refuses a port change while this instance's server runs", async () => {
    const { server } = manager();
    await server.start();
    const routes = createVoiceRoutes({} as Config, { server });
    const res = await routes.request("/server", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 9000 }),
    });
    expect(res.status).toBe(409);
  });
});

describe("assertHubModelId", () => {
  it("accepts a namespace/name id", () => {
    expect(assertHubModelId("mlx-community/Kokoro-82M-bf16")).toBe("mlx-community/Kokoro-82M-bf16");
  });

  it("refuses a tagged or flag-shaped id", () => {
    expect(() => assertHubModelId("whisper:latest")).toThrow();
    expect(() => assertHubModelId("--token")).toThrow();
  });
});
