import { spawn } from "node:child_process";
import type { SpecialistDefinition } from "../agents/catalog.ts";
import { findSpecialist } from "../agents/catalog.ts";
import { runSpecialistDefinition } from "../agents/run.ts";
import { alwaysOnBuiltinToolNames } from "../agentTools/registry.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { claudeChildEnv, claudeProgram, validateWorkingDir } from "../lib/claudeCli.ts";
import type { AgentJobTarget } from "./agentJobs.ts";

/**
 * The agent backends a scheduled job can run on.
 *
 * Two today: the in-app assistant (a specialist, or the default agent) and a
 * headless Claude Code process. They share one interface because the job
 * machinery — schedule, lease, run history — is the same either way, and the
 * difference is only where the prompt is sent and what comes back.
 *
 * Claude Code runs headless (`claude -p`) rather than in a PTY: a scheduled run
 * has nobody watching it, and its whole product is the text it answers with,
 * which the PTY sessions in the Rust core have no way to hand back.
 */

export interface AgentJobRunInput {
  config: Config;
  db: Db;
  target: AgentJobTarget;
  /** The job's configured instructions. */
  prompt: string;
  signal: AbortSignal;
}

export interface AgentJobRunResult {
  /** What the agent answered. Truncated and redacted by the caller. */
  output: string;
}

export type AgentJobRunner = (input: AgentJobRunInput) => Promise<AgentJobRunResult>;

/**
 * Tools the composed default definition holds: the families a chat turn carries
 * by default. Starting from every built-in instead would hand an unattended run
 * a wider surface than any written specialist asks for, and put 57 schemas in
 * front of the model — which `agentTools/registry.ts` records as measurably
 * degrading which tool it picks. `selectTools` still drops delegation and
 * anything needing an explicit grant.
 */
function defaultAgentTools(): string[] {
  return alwaysOnBuiltinToolNames();
}

/** Steps the composed default definition gets; a written specialist sets its own. */
const DEFAULT_AGENT_MAX_STEPS = 24;

/**
 * The definition used when a job names no specialist: the assistant's ordinary
 * tool surface with no system prompt of its own, so the job's prompt is the
 * whole instruction.
 */
function defaultAgentDefinition(): SpecialistDefinition {
  return {
    name: "default agent",
    description: "The assistant's default agent, running a scheduled job's prompt.",
    prompt:
      "You are Yarvis's default agent, running a scheduled job on the user's behalf. Carry out the instructions below and report what you did and what you found.",
    tools: defaultAgentTools(),
    unattended: [],
    provider: null,
    model: null,
    complexityTier: null,
    maxSteps: DEFAULT_AGENT_MAX_STEPS,
    enabled: true,
    source: "builtin",
    path: "",
  };
}

async function runYarvisJob(input: AgentJobRunInput): Promise<AgentJobRunResult> {
  if (input.target.kind !== "yarvis") throw new Error("not a yarvis job");
  const name = input.target.specialist;
  let definition: SpecialistDefinition;
  if (name) {
    const found = await findSpecialist(name);
    if (!found) throw new Error(`no specialist named "${name}"`);
    if (!found.enabled) throw new Error(`specialist "${found.name}" is disabled`);
    definition = found;
  } else {
    definition = defaultAgentDefinition();
  }

  const run = await runSpecialistDefinition({
    config: input.config,
    db: input.db,
    specialist: definition,
    task: input.prompt,
    signal: input.signal,
  });
  return { output: run.text };
}

/** Ceiling on how much of a headless run's output is kept in memory. */
const MAX_CAPTURED_CHARS = 200_000;

/** How much of a failed run's output travels in the thrown error. */
const MAX_ERROR_CHARS = 2_000;

export interface SpawnedRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable process launcher, so the runner is testable without Claude Code. */
export type ClaudeLauncher = (input: {
  program: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
}) => Promise<SpawnedRun>;

/** Runs the binary, capturing both streams up to {@link MAX_CAPTURED_CHARS}. */
const spawnClaude: ClaudeLauncher = ({ program, args, cwd, signal }) =>
  new Promise<SpawnedRun>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      signal,
      env: claudeChildEnv(),
      // No shell: the prompt and the directory are user-supplied, and passing
      // them as argv means nothing in them is ever interpreted as a command.
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: string) =>
      current.length >= MAX_CAPTURED_CHARS
        ? current
        : (current + chunk).slice(0, MAX_CAPTURED_CHARS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

/** What `--output-format json` reports about a finished headless run. */
export interface ClaudeResult {
  text: string;
  isError: boolean;
  sessionId: string | null;
}

/**
 * Pulls the answer out of `--output-format json`.
 *
 * Claude Code answers with an object carrying `result`, `is_error` and the
 * session id. Anything else (a version that changed the shape, a wrapper that
 * printed something first) falls back to the raw text rather than losing the
 * run's output to a parse failure — so a run whose output can't be parsed is
 * still readable in the history.
 */
export function parseClaudeOutput(stdout: string): ClaudeResult {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", isError: false, sessionId: null };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const body = parsed as { result?: unknown; is_error?: unknown; session_id?: unknown };
      if (typeof body.result === "string") {
        return {
          text: body.result,
          isError: body.is_error === true,
          sessionId: typeof body.session_id === "string" ? body.session_id : null,
        };
      }
    }
  } catch {
    // Not JSON — see above.
  }
  return { text: trimmed, isError: false, sessionId: null };
}

export function createClaudeCodeRunner(launch: ClaudeLauncher = spawnClaude): AgentJobRunner {
  return async (input) => {
    if (input.target.kind !== "claude-code") throw new Error("not a claude-code job");
    const cwd = validateWorkingDir(input.target.cwd);
    const program = await claudeProgram();
    // The two rules `selectTools` enforces for an in-app delegated run hold here
    // too, and Claude Code has to be told: without `--strict-mcp-config` it
    // loads the user's MCP servers plus any `.mcp.json` in the directory the job
    // names, and `Task` is delegation by another name. Neither belongs in a run
    // with nobody to approve a tool call.
    const args = [
      "-p",
      input.prompt,
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--disallowed-tools",
      "Task",
    ];
    if (input.target.model) args.push("--model", input.target.model);
    if (input.target.permissionMode) args.push("--permission-mode", input.target.permissionMode);
    const { code, stdout, stderr } = await launch({ program, args, cwd, signal: input.signal });
    const result = parseClaudeOutput(stdout);
    // `is_error` is how a run that reached the model and then failed reports
    // itself; the exit code covers the rest (a bad flag, no auth, a crash).
    if (code !== 0 || result.isError) {
      const detail = (result.text.trim() || stderr.trim() || "no output").slice(0, MAX_ERROR_CHARS);
      throw new Error(`claude exited with code ${code ?? "null"}: ${detail}`);
    }
    return { output: result.text };
  };
}

export interface RunnerSet {
  yarvis: AgentJobRunner;
  "claude-code": AgentJobRunner;
}

/** The runners a scheduler uses unless a test injects its own. */
export function defaultRunners(): RunnerSet {
  return { yarvis: runYarvisJob, "claude-code": createClaudeCodeRunner() };
}
