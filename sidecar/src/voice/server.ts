import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createCustomProvider, listCustomProviders } from "../customProviders/service.ts";
import { claudeChildEnv } from "../lib/claudeCli.ts";
import { guardedFetch } from "../lib/guardedFetch.ts";
import { saveProviderModel } from "../llm/catalog.ts";
import { CUSTOM_PROVIDER_PREFIX } from "../llm/providers.ts";
import { readSection, settingsPath, withSection } from "../settings/store.ts";
import { assertModelId } from "./speech.ts";

/**
 * Starts and stops the local mlx-audio speech server, and downloads the models
 * it serves, so voice works without a terminal kept open beside the app.
 *
 * The server runs through `uvx` from pinned package specs rather than the
 * repo's `pyproject.toml`, because a packaged app has no repo checkout to run
 * `uv sync` in. The specs mirror that file.
 *
 * Only a server Yarvis started is stopped from here. One the user started by
 * hand or with launchd shows up as `external`: it is used, but a second one is
 * not started on the same port. The pid of the server Yarvis started is kept
 * on disk, because the core SIGKILLs the sidecar on a restart and no exit hook
 * runs then: the next sidecar adopts the server instead of stranding it.
 */

const SERVER_PACKAGES = ["mlx-audio[server]>=0.4.8", "misaki[en]>=0.9.4", "setuptools<81"];

export const DEFAULT_SPEECH_SERVER_PORT = 8000;

/** Lines of the server's output kept for the status view. */
const LOG_TAIL_LINES = 200;

/** How long one readiness probe waits; the server answers instantly once it is up. */
const PROBE_TIMEOUT_MS = 1500;

/** How long Stop waits for the port to go quiet before reporting. */
const STOP_WAIT_MS = 5000;

export type LocalModelKind = "stt" | "tts";

export interface LocalSpeechModel {
  id: string;
  kind: LocalModelKind;
  /** Speaks in the voice of a reference clip. */
  cloning: boolean;
  note: string;
}

/** Models verified on Apple Silicon through mlx-audio (see docs/voice-server.md). */
export const LOCAL_SPEECH_MODELS: LocalSpeechModel[] = [
  {
    id: "mlx-community/Soprano-1.1-80M-bf16",
    kind: "tts",
    cloning: false,
    note: "Small, needs no extra setup. Start here.",
  },
  {
    id: "mlx-community/Kokoro-82M-bf16",
    kind: "tts",
    cloning: false,
    note: "Nicer voice. Set Voice to af_heart. Needs the espeak-ng fix in the docs.",
  },
  {
    id: "mlx-community/MOSS-TTS-Nano-100M",
    kind: "tts",
    cloning: true,
    note: "Clones a voice from a 5–10 second clip.",
  },
  {
    id: "mlx-community/whisper-large-v3-turbo-asr-fp16",
    kind: "stt",
    cloning: false,
    note: "Speech to text.",
  },
];

export interface SpeechServerSettings {
  port: number;
}

const SETTINGS_KEY = "speechServer";

export async function getSpeechServerSettings(): Promise<SpeechServerSettings> {
  const stored = await readSection<Partial<SpeechServerSettings>>(SETTINGS_KEY);
  return { port: DEFAULT_SPEECH_SERVER_PORT, ...stored };
}

export async function saveSpeechServerSettings(
  input: Partial<SpeechServerSettings>,
): Promise<SpeechServerSettings> {
  return withSection<Partial<SpeechServerSettings>, SpeechServerSettings>(
    SETTINGS_KEY,
    (current) => {
      const next = { port: DEFAULT_SPEECH_SERVER_PORT, ...current, ...input };
      return { next, result: next };
    },
  );
}

export type SpeechServerState = "stopped" | "starting" | "running" | "external" | "failed";

export interface SpeechServerStatus {
  state: SpeechServerState;
  port: number;
  baseUrl: string;
  /** Output from the server this instance started, newest last. */
  log: string[];
  error: string | null;
}

export type DownloadState = "absent" | "downloading" | "downloaded" | "failed";

export interface LocalModelStatus extends LocalSpeechModel {
  state: DownloadState;
  error: string | null;
}

/** What the manager needs from the outside world, swapped out by tests. */
export interface SpeechServerDeps {
  spawn: (program: string, args: string[]) => ChildProcess;
  /** True when something answers the OpenAI model list on the port. */
  probe: (port: number) => Promise<boolean>;
  /** Hugging Face hub cache folder that downloads land in. */
  hubCacheDir: () => string;
  /**
   * True when `pid` is still a speech server Yarvis started, rather than an
   * unrelated process that reused the pid.
   */
  isSpeechServer: (pid: number) => boolean;
}

/**
 * The child gets a built environment rather than the sidecar's, which holds
 * every provider key and the loopback API's bearer. The Hugging Face cache
 * variables are added so downloads land where the user already keeps them.
 */
function speechChildEnv(): NodeJS.ProcessEnv {
  const env = claudeChildEnv();
  for (const key of ["HF_HOME", "HF_HUB_CACHE", "XDG_CACHE_HOME"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export const defaultSpeechServerDeps: SpeechServerDeps = {
  spawn: (program, args) =>
    spawn(program, args, {
      env: speechChildEnv(),
      shell: false,
      // Its own process group, so stopping it reaches the Python process uvx starts.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  probe: async (port) => {
    try {
      const { response } = await guardedFetch(
        `http://127.0.0.1:${port}/v1/models`,
        { method: "GET" },
        { allowLoopback: true, timeoutMs: PROBE_TIMEOUT_MS },
      );
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  },
  hubCacheDir: () => {
    if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
    const home =
      process.env.HF_HOME ??
      join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "huggingface");
    return join(home, "hub");
  },
  isSpeechServer: (pid) => {
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return ps.status === 0 && ps.stdout.includes("mlx_audio.server");
  },
};

/** Where the pid of the server Yarvis started is kept between sidecars. */
function pidFile(): string {
  return join(dirname(settingsPath()), "speech-server.json");
}

interface ServerRecord {
  pid: number;
  port: number;
}

function readRecord(): ServerRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(pidFile(), "utf8")) as Partial<ServerRecord>;
    return typeof parsed.pid === "number" && typeof parsed.port === "number"
      ? { pid: parsed.pid, port: parsed.port }
      : null;
  } catch {
    return null;
  }
}

function writeRecord(record: ServerRecord): void {
  try {
    writeFileSync(pidFile(), JSON.stringify(record), { mode: 0o600 });
  } catch (e) {
    console.warn("[voice] could not record the speech server's pid:", e);
  }
}

function clearRecord(): void {
  rmSync(pidFile(), { force: true });
}

/** A downloadable model is a plain Hub `namespace/name`: no Ollama tag, nothing else. */
export function assertHubModelId(model: string): string {
  assertModelId(model);
  if (!/^[^/:]+\/[^/:]+$/.test(model)) {
    throw new Error(`not a Hugging Face model id: ${model}`);
  }
  return model;
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

export class LocalSpeechServer {
  private child: ChildProcess | null = null;
  private log: string[] = [];
  private error: string | null = null;
  private port = DEFAULT_SPEECH_SERVER_PORT;
  private readonly downloads = new Map<string, { state: DownloadState; error: string | null }>();
  private exitHookInstalled = false;
  /** Set for the whole of a start, so two overlapping requests spawn one server. */
  private starting: Promise<SpeechServerStatus> | null = null;

  constructor(private readonly deps: SpeechServerDeps = defaultSpeechServerDeps) {}

  private append(chunk: Buffer | string): void {
    const lines = chunk.toString().split("\n").filter(Boolean);
    this.log = [...this.log, ...lines].slice(-LOG_TAIL_LINES);
  }

  /** A server the sidecar started must not outlive it, or the port stays taken. */
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.on("exit", () => {
      if (this.child?.pid !== undefined) killGroup(this.child.pid);
    });
  }

  /** A server an earlier sidecar started that is still running. */
  private adopted(): ServerRecord | null {
    if (this.child) return null;
    const record = readRecord();
    if (!record) return null;
    if (this.deps.isSpeechServer(record.pid)) return record;
    clearRecord();
    return null;
  }

  async status(): Promise<SpeechServerStatus> {
    const adopted = this.adopted();
    const owned = this.child !== null || adopted !== null;
    const port = this.child ? this.port : (adopted?.port ?? (await getSpeechServerSettings()).port);
    const answering = await this.deps.probe(port);
    let state: SpeechServerState;
    if (owned) state = answering ? "running" : "starting";
    else if (answering) state = "external";
    else state = this.error ? "failed" : "stopped";
    return {
      state,
      port,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      log: this.log,
      error: this.error,
    };
  }

  start(): Promise<SpeechServerStatus> {
    this.starting ??= this.spawnServer().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawnServer(): Promise<SpeechServerStatus> {
    if (this.child || this.adopted()) return this.status();
    const { port } = await getSpeechServerSettings();
    // Something already serves the port: another instance's server, or one the
    // user runs themselves. Starting a second would only fail to bind.
    if (await this.deps.probe(port)) return this.status();

    this.port = port;
    this.log = [];
    this.error = null;
    this.installExitHook();
    const args = [
      "--python",
      "3.12",
      ...SERVER_PACKAGES.flatMap((spec, i) => [i === 0 ? "--from" : "--with", spec]),
      "mlx_audio.server",
      // Loopback only: the server has no authentication.
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      // mlx-audio allows every origin by default, which would let any web page
      // the user opens drive the server. The sidecar sends no Origin at all.
      "--allowed-origins",
      `http://127.0.0.1:${port}`,
    ];
    const child = this.deps.spawn("uvx", args);
    this.child = child;
    if (child.pid !== undefined) writeRecord({ pid: child.pid, port });
    child.stdout?.on("data", (chunk) => this.append(chunk));
    child.stderr?.on("data", (chunk) => this.append(chunk));
    child.on("error", (e) => {
      this.error =
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "uv is not installed. Install it with `brew install uv`."
          : e.message;
      if (this.child === child) this.child = null;
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      clearRecord();
      if (code !== 0 && signal !== "SIGTERM") {
        this.error = `the speech server exited (${signal ?? `code ${code}`}); see its log`;
      }
    });
    return this.status();
  }

  async stop(): Promise<SpeechServerStatus> {
    const adopted = this.adopted();
    const pid = this.child?.pid ?? adopted?.pid;
    const port = adopted?.port ?? this.port;
    this.child = null;
    this.error = null;
    if (pid !== undefined) killGroup(pid);
    clearRecord();
    // Uvicorn keeps answering for a moment after SIGTERM, and with no child
    // left that reads as a server started elsewhere.
    const deadline = Date.now() + STOP_WAIT_MS;
    while (pid !== undefined && Date.now() < deadline && (await this.deps.probe(port))) {
      await Bun.sleep(200);
    }
    return this.status();
  }

  /** A snapshot, not just the model's folder: a cancelled download leaves the folder behind. */
  private isDownloaded(model: string): boolean {
    const snapshots = join(
      this.deps.hubCacheDir(),
      `models--${model.replace("/", "--")}`,
      "snapshots",
    );
    try {
      return readdirSync(snapshots).length > 0;
    } catch {
      return false;
    }
  }

  private modelState(model: string): { state: DownloadState; error: string | null } {
    const tracked = this.downloads.get(model);
    if (tracked?.state === "downloading") return tracked;
    if (this.isDownloaded(model)) return { state: "downloaded", error: null };
    return tracked ?? { state: "absent", error: null };
  }

  models(): LocalModelStatus[] {
    return LOCAL_SPEECH_MODELS.map((m) => ({ ...m, ...this.modelState(m.id) }));
  }

  /**
   * Fetches a model into the Hugging Face cache, so its first use doesn't
   * stall on a download that looks like a hung request. Answers at once; the
   * state moves to `downloaded` or `failed` when the child exits.
   */
  download(model: string): { state: DownloadState; error: string | null } {
    assertHubModelId(model);
    if (this.downloads.get(model)?.state === "downloading") return this.modelState(model);
    this.downloads.set(model, { state: "downloading", error: null });
    const child = this.deps.spawn("uvx", ["--from", "huggingface_hub", "hf", "download", model]);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const fail = (message: string) =>
      this.downloads.set(model, { state: "failed", error: message });
    child.on("error", (e) => fail(e.message));
    child.on("exit", (code) => {
      if (code === 0) this.downloads.set(model, { state: "downloaded", error: null });
      else fail(stderr.trim().split("\n").at(-1) || `download exited with code ${code}`);
    });
    return this.modelState(model);
  }

  /**
   * Makes sure a custom provider points at the server and that its catalogue
   * tags the verified models, so they appear in the speech pickers. Returns the
   * provider's voice id. An existing provider on the same URL is reused rather
   * than duplicated.
   */
  async ensureProvider(): Promise<string> {
    const { port } = await getSpeechServerSettings();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const existing = (await listCustomProviders()).find(
      (row) => row.baseUrl.replace(/\/$/, "") === baseUrl,
    );
    const row =
      existing ??
      (await createCustomProvider({
        name: "Local speech",
        baseUrl,
        apiKind: "openai",
        models: [],
        headerNames: [],
      }));
    const providerId = `${CUSTOM_PROVIDER_PREFIX}${row.id}`;
    for (const [sortOrder, model] of LOCAL_SPEECH_MODELS.entries()) {
      await saveProviderModel({
        providerId,
        modelId: model.id,
        capabilities: [model.kind],
        sortOrder,
      });
    }
    return providerId;
  }
}
