import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCustomProviders } from "../customProviders/service.ts";
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
    isSpeechServer: () => false,
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

  it("adopts a server an earlier sidecar started, so it can still be stopped", async () => {
    // A pid that is not running: the stop's kill is a no-op either way.
    const pid = 2_147_483_000;
    const first = manager();
    const child = fakeChild();
    Object.assign(child, { pid });
    await new LocalSpeechServer({
      ...{ probe: async () => false, hubCacheDir: () => join(dir, "hub") },
      spawn: () => child,
      isSpeechServer: () => false,
    }).start();
    expect(first.spawned).toHaveLength(0);

    let alive = true;
    const next = manager({ probe: async () => alive, isSpeechServer: (p) => alive && p === pid });
    expect((await next.server.status()).state).toBe("running");
    expect((await next.server.start()).state).toBe("running");
    expect(next.spawned).toHaveLength(0);

    const stopping = next.server.stop();
    alive = false;
    expect((await stopping).state).toBe("stopped");
  });

  it("uses a server already on the port rather than starting a second one", async () => {
    const { server, spawned } = manager({ probe: async () => true });
    expect((await server.start()).state).toBe("external");
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
    const first = await server.ensureProvider();
    const second = await server.ensureProvider();
    expect(second).toBe(first);
    expect(await listCustomProviders()).toHaveLength(1);
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
