import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { processStartTime } from "../agentRuns/process.ts";
import { loadInstanceConfig } from "../config.ts";
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
 * Only the instance that started a server stops it. Any other mlx-audio server
 * on the port shows up as `external`: one another Yarvis instance started
 * (named in `owner`), or one the user runs by hand or with launchd. It is used,
 * but a second one is not started on the same port. Anything else answering on
 * the port is `occupied` and not used at all. Who started which server is kept on disk,
 * keyed by instance, because the core SIGKILLs the sidecar on a restart and no
 * exit hook runs then: the next sidecar of the same instance adopts the server
 * instead of stranding it.
 */

const SERVER_PACKAGES = ["mlx-audio[server]>=0.4.8", "misaki[en]>=0.9.4", "setuptools<81"];

export const DEFAULT_SPEECH_SERVER_PORT = 8000;

/** Lines of the server's output kept for the status view. */
const LOG_TAIL_LINES = 200;

/** How long one readiness probe waits; the server answers instantly once it is up. */
const PROBE_TIMEOUT_MS = 1500;

/** How long a port's listener is remembered, so a status poll doesn't run lsof each time. */
const LISTENER_CACHE_MS = 10_000;

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

/**
 * `occupied` is a port something other than mlx-audio answers on: it is neither
 * used nor offered as a speech provider.
 */
export type SpeechServerState =
  | "stopped"
  | "starting"
  | "running"
  | "external"
  | "occupied"
  | "failed";

export interface SpeechServerStatus {
  state: SpeechServerState;
  /** The Yarvis instance that started an `external` server, or null when Yarvis didn't. */
  owner: string | null;
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
   * When `pid` started, as `ps` reports it, or null when no such process runs.
   * Compared with the time recorded at spawn, so a reused pid isn't adopted.
   */
  processStartTime: (pid: number) => Promise<string | null>;
  /** Command line of the process listening on the port, or null when none is found. */
  listenerCommand: (port: number) => Promise<string | null>;
  /** This app instance's name, which keys the record of the server it started. */
  instance: string;
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
      // Read to the end rather than cancelled: cancelling the pinned transport's
      // stream mid-flight throws an uncaught error that takes the sidecar down.
      await response.arrayBuffer().catch(() => undefined);
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
  processStartTime,
  listenerCommand: async (port) => {
    const pids = await commandOutput("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pid = pids?.split("\n")[0];
    return pid ? commandOutput("ps", ["-o", "command=", "-p", pid]) : null;
  },
  instance: loadInstanceConfig().name,
};

/** A command's trimmed stdout, or null when it fails or prints nothing. */
function commandOutput(program: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(program, args, (error, stdout) => {
      const out = stdout.trim();
      resolve(error || !out ? null : out);
    });
  });
}

/** True when a listener's command line is mlx-audio's server. */
function isMlxAudio(command: string | null): boolean {
  return command?.includes("mlx_audio.server") ?? false;
}

/** Where each instance records the server it started, kept between sidecars. */
function recordFile(): string {
  return join(dirname(settingsPath()), "speech-server.json");
}

interface ServerRecord {
  pid: number;
  port: number;
  /**
   * The process's start time as `ps -o lstart=` prints it, compared as an
   * opaque string so a pid reused by another process isn't mistaken for it.
   * Null when `ps` couldn't be asked at spawn.
   */
  startedAt: string | null;
}

type ServerRecords = Record<string, ServerRecord>;

function isRecord(value: unknown): value is ServerRecord {
  const row = value as Partial<ServerRecord> | null;
  return (
    typeof row?.pid === "number" &&
    typeof row.port === "number" &&
    (typeof row.startedAt === "string" || row.startedAt === null)
  );
}

function readRecords(): ServerRecords {
  try {
    const parsed = JSON.parse(readFileSync(recordFile(), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, row]) => isRecord(row)),
    ) as ServerRecords;
  } catch {
    return {};
  }
}

/**
 * Written to a temp file and renamed, like `settings.json` beside it, so another
 * instance never reads half a file and writes back an empty list.
 */
function writeRecords(records: ServerRecords): void {
  try {
    const file = recordFile();
    if (Object.keys(records).length === 0) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(records), { mode: 0o600 });
    renameSync(temp, file);
  } catch (e) {
    console.warn("[voice] could not record the speech server's pid:", e);
  }
}

function setRecord(instance: string, record: ServerRecord | null): void {
  const { [instance]: _, ...others } = readRecords();
  writeRecords(record ? { ...others, [instance]: record } : others);
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
  /** A server an earlier sidecar of this instance started, once this one has adopted it. */
  private adoptedPid: number | null = null;
  private listenerCache: { port: number; command: string | null; at: number } | null = null;
  /** Set for the whole of a start, so two overlapping requests spawn one server. */
  private starting: Promise<SpeechServerStatus> | null = null;

  constructor(private readonly deps: SpeechServerDeps = defaultSpeechServerDeps) {}

  private append(chunk: Buffer | string): void {
    const lines = chunk.toString().split("\n").filter(Boolean);
    this.log = [...this.log, ...lines].slice(-LOG_TAIL_LINES);
  }

  /**
   * A server this instance owns, started or adopted, must not outlive the
   * sidecar, or the port stays taken with nobody able to stop it.
   */
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.on("exit", () => {
      const pid = this.child?.pid ?? this.adoptedPid;
      if (pid !== undefined && pid !== null) killGroup(pid);
    });
  }

  /**
   * Whether a record still names the process it was written for. It also
   * tidies: a record is dropped once its process is gone or its pid belongs to
   * a newer process, whichever instance wrote it. A record that can't be
   * checked, because `ps` failed now or at spawn, is kept but not trusted.
   */
  private async isRecordedProcess(instance: string, record: ServerRecord): Promise<boolean> {
    let started: string | null;
    try {
      started = await this.deps.processStartTime(record.pid);
    } catch (e) {
      console.warn(`[voice] could not check speech server ${record.pid}:`, e);
      return false;
    }
    if (started !== null && record.startedAt === null) return false;
    if (started !== null && started === record.startedAt) return true;
    setRecord(instance, null);
    return false;
  }

  /** A server an earlier sidecar of this instance started that is still running. */
  private async adopted(): Promise<ServerRecord | null> {
    if (this.child) return null;
    const record = readRecords()[this.deps.instance];
    if (!record || !(await this.isRecordedProcess(this.deps.instance, record))) {
      this.adoptedPid = null;
      return null;
    }
    this.adoptedPid = record.pid;
    this.installExitHook();
    return record;
  }

  /** The other instance whose live server listens on the port, if there is one. */
  private async ownerOf(port: number): Promise<string | null> {
    for (const [instance, record] of Object.entries(readRecords())) {
      if (instance === this.deps.instance || record.port !== port) continue;
      if (await this.isRecordedProcess(instance, record)) return instance;
    }
    return null;
  }

  /** The listener's command line, remembered briefly; it doesn't change between polls. */
  private async listenerCommand(port: number): Promise<string | null> {
    const cached = this.listenerCache;
    if (cached?.port === port && Date.now() - cached.at < LISTENER_CACHE_MS) return cached.command;
    const command = await this.deps.listenerCommand(port);
    this.listenerCache = { port, command, at: Date.now() };
    return command;
  }

  async status(): Promise<SpeechServerStatus> {
    const adopted = await this.adopted();
    const owned = this.child !== null || adopted !== null;
    const port = this.child ? this.port : (adopted?.port ?? (await getSpeechServerSettings()).port);
    const answering = await this.deps.probe(port);
    let state: SpeechServerState;
    let owner: string | null = null;
    if (owned) state = answering ? "running" : "starting";
    else if (answering) {
      owner = await this.ownerOf(port);
      // Anything can answer a model list on a common port like 8000, so an
      // unclaimed listener must be mlx-audio itself before it is used.
      state = owner || isMlxAudio(await this.listenerCommand(port)) ? "external" : "occupied";
    } else state = this.error ? "failed" : "stopped";
    return {
      state,
      owner,
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
    if (this.child || (await this.adopted())) return this.status();
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
    // Listeners first: a uvx that fails fast can exit while the record is written.
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
      setRecord(this.deps.instance, null);
      if (code !== 0 && signal !== "SIGTERM") {
        this.error = `the speech server exited (${signal ?? `code ${code}`}); see its log`;
      }
    });
    if (child.pid !== undefined) await this.record(child, child.pid, port);
    return this.status();
  }

  private async record(child: ChildProcess, pid: number, port: number): Promise<void> {
    let startedAt: string | null = null;
    try {
      startedAt = await this.deps.processStartTime(pid);
    } catch (e) {
      console.warn("[voice] could not read the speech server's start time:", e);
    }
    // It may already have exited, and its exit handler cleared the record.
    if (this.child === child) setRecord(this.deps.instance, { pid, port, startedAt });
  }

  /** Stops the server this instance started. Anyone else's is left running. */
  async stop(): Promise<SpeechServerStatus> {
    const adopted = await this.adopted();
    const pid = this.child?.pid ?? adopted?.pid;
    const port = adopted?.port ?? this.port;
    this.child = null;
    this.adoptedPid = null;
    this.error = null;
    if (pid !== undefined) killGroup(pid);
    setRecord(this.deps.instance, null);
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
   * provider id (`custom:<id>`). An existing provider on the same URL is reused rather
   * than duplicated. `port` is the one a status check just found mlx-audio on.
   */
  async ensureProvider(port: number): Promise<string> {
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
