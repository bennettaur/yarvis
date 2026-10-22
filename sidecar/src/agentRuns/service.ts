import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { loadInstanceConfig } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type AgentRunRow, agentRuns } from "../db/schema.ts";
import type { ClaudePermissionMode } from "../jobs/agentJobs.ts";
import { claudeProgram, validateWorkingDir } from "../lib/claudeCli.ts";
import { redactSecrets } from "../llm/errors.ts";
import type { AgentRunEvent, AgentRunFinalStatus } from "./events.ts";
import { materializePlugin, type PluginName } from "./plugins.ts";
import { launchStreaming } from "./process.ts";
import { type AgentRunRegistry, agentRunRegistry } from "./registry.ts";
import { type ClaudeStreamResult, StreamJsonParser } from "./streamJson.ts";

/**
 * Headless Claude Code runs a feature starts and the UI follows live: a
 * verification report, a mutation-testing pass. The feature's own route starts
 * the run and gets its id back at once; the run carries on in the background
 * whether or not anyone is watching, streaming through `registry.ts` and ending
 * in an `agent_runs` row.
 *
 * The run is told, not trusted. Like a scheduled Claude Code job it gets a
 * built environment (no sidecar token or provider keys), argv with no shell,
 * and no MCP servers. Two lines go further, because these runs are pointed at a
 * pull request's checkout, which its author controls:
 *
 * - only the user's own Claude Code settings load (`--setting-sources user`):
 *   a checkout's `.claude/settings.json` can declare hooks, which are shell
 *   commands Claude Code runs itself, and running a PR's code is something the
 *   user consents to separately;
 * - no session is saved (`--no-session-persistence`), so the transcript never
 *   reaches the nightly Claude Code session digest and from there memory.
 */

export interface ClaudeRunOptions<T = unknown> {
  /** What the run is for, e.g. "verification-report". */
  kind: string;
  /** What it runs against, e.g. a PR's `refKey`. */
  targetKey: string;
  /** Absolute path of an existing directory to run in. */
  cwd: string;
  prompt: string;
  /**
   * The answer's shape. Sent to Claude Code as `--json-schema`, and the run
   * fails unless its structured output parses against it.
   */
  outputSchema?: z.ZodType<T>;
  /** Shipped plugins to load (`--plugin-dir`), written out before the run. */
  plugins?: PluginName[];
  /** Tools the run may use without asking; anything else is denied, since nobody can answer a prompt. */
  allowedTools: string[];
  disallowedTools?: string[];
  permissionMode?: ClaudePermissionMode;
  appendSystemPrompt?: string;
  model?: string;
  /** Claude Code stops the run once it has spent this much. */
  maxBudgetUsd?: number;
  timeoutMs: number;
  /** Feature-specific context kept on the row. */
  meta?: Record<string, unknown>;
}

export interface AgentRunOutcome<T = unknown> {
  status: AgentRunFinalStatus;
  /** The validated structured output; null without a schema or on failure. */
  output: T | null;
  text: string | null;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  sessionId: string | null;
}

export interface ClaudeRunHandle<T = unknown> {
  id: string;
  /** Settles when the run ends and its row is written. Never rejects. */
  done: Promise<AgentRunOutcome<T>>;
}

/** What tests swap out. */
export interface ClaudeRunDeps {
  registry?: AgentRunRegistry;
  /** The executable; defaults to the configured Claude Code build. */
  program?: string;
  instance?: string;
  pluginsRoot?: string;
}

/**
 * The JSON Schema handed to `--json-schema`. Claude Code rejects a `$schema`
 * naming draft 2020-12, which is what zod emits, so that key is dropped.
 */
export function jsonSchemaArg(schema: z.ZodType): string {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** The argv after the program. Exported for tests. */
export function buildClaudeArgs(options: ClaudeRunOptions, pluginDirs: string[]): string[] {
  // The prompt comes first, straight after `-p`: the tool lists below are
  // variadic, and a positional argument after one would be read as a tool.
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    // Required by stream-json under `-p`.
    "--verbose",
    "--strict-mcp-config",
    "--setting-sources",
    "user",
    "--no-session-persistence",
  ];
  for (const dir of pluginDirs) args.push("--plugin-dir", dir);
  if (options.allowedTools.length > 0) args.push("--allowedTools", ...options.allowedTools);
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...options.disallowedTools);
  }
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
  if (options.model) args.push("--model", options.model);
  if (options.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }
  if (options.outputSchema) args.push("--json-schema", jsonSchemaArg(options.outputSchema));
  return args;
}

/** Redacts every string inside a structured output before it is stored or shown. */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

/** Longest error message kept from a failed run's stderr. */
const MAX_ERROR_CHARS = 2_000;

/**
 * Starts a run and returns as soon as it is registered. Throws — before any
 * row exists — for a working directory that isn't there or a plugin that
 * can't be written, so the starting route can answer with the reason.
 */
export async function startClaudeRun<T>(
  db: Db,
  options: ClaudeRunOptions<T>,
  deps: ClaudeRunDeps = {},
): Promise<ClaudeRunHandle<T>> {
  const registry = deps.registry ?? agentRunRegistry;
  const cwd = validateWorkingDir(options.cwd);
  const pluginDirs = (options.plugins ?? []).map((name) =>
    materializePlugin(name, deps.pluginsRoot),
  );
  const program = deps.program ?? (await claudeProgram());
  const args = buildClaudeArgs(options, pluginDirs);

  const [row] = await db
    .insert(agentRuns)
    .values({
      kind: options.kind,
      targetKey: options.targetKey,
      status: "running",
      instance: deps.instance ?? loadInstanceConfig().name,
      meta: options.meta ?? {},
    })
    .returning({ id: agentRuns.id });
  if (!row) throw new Error("could not record the agent run");
  const id = row.id;
  const signal = registry.start(id);
  const emit = (event: AgentRunEvent) => registry.emit(id, event);

  const execute = async (): Promise<AgentRunOutcome<T>> => {
    const parser = new StreamJsonParser(cwd);
    let result: ClaudeStreamResult | undefined;
    let exit: Awaited<ReturnType<typeof launchStreaming>> | undefined;
    let launchError: string | null = null;
    emit({ type: "status", message: "Starting Claude Code" });
    try {
      exit = await launchStreaming({
        program,
        args,
        cwd,
        signal,
        timeoutMs: options.timeoutMs,
        onLine: (line) => {
          const parsed = parser.parseLine(line);
          for (const event of parsed.events) emit(event);
          if (parsed.result) result = parsed.result;
        },
      });
    } catch (e) {
      launchError = `could not start Claude Code: ${e instanceof Error ? e.message : String(e)}`;
    }
    return settle(options, { result, exit, launchError });
  };

  const done = execute()
    .catch(
      (e): AgentRunOutcome<T> => ({
        status: "failed",
        output: null,
        text: null,
        error: e instanceof Error ? e.message : String(e),
        costUsd: null,
        durationMs: null,
        sessionId: null,
      }),
    )
    .then(async (outcome) => {
      if (outcome.status === "succeeded") {
        emit({
          type: "result",
          output: outcome.output,
          text: outcome.text ?? "",
          costUsd: outcome.costUsd,
          durationMs: outcome.durationMs,
          sessionId: outcome.sessionId,
        });
      } else if (outcome.status === "failed" && outcome.error) {
        emit({ type: "error", message: outcome.error });
      }
      const final: AgentRunEvent = { type: "done", status: outcome.status, error: outcome.error };
      // The row is written before the final event goes out and the run stops
      // being live, so a viewer arriving in between finds the finished row
      // rather than a `running` one with no live stream behind it.
      try {
        await db
          .update(agentRuns)
          .set({
            status: outcome.status,
            result: outcome.output ?? null,
            error: outcome.error,
            costUsd: outcome.costUsd,
            sessionId: outcome.sessionId,
            events: [...registry.history(id), final],
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, id));
      } catch (e) {
        console.error(`[agent-runs] could not record the end of run ${id}:`, e);
      }
      emit(final);
      registry.finish(id);
      return outcome;
    });
  return { id, done };
}

/** Turns how the process ended, and what it said last, into the run's outcome. */
function settle<T>(
  options: ClaudeRunOptions<T>,
  ended: {
    result: ClaudeStreamResult | undefined;
    exit: { code: number | null; stderr: string; timedOut: boolean; aborted: boolean } | undefined;
    launchError: string | null;
  },
): AgentRunOutcome<T> {
  const { result, exit } = ended;
  const base = {
    output: null,
    text: result?.text ?? null,
    costUsd: result?.costUsd ?? null,
    durationMs: result?.durationMs ?? null,
    sessionId: result?.sessionId ?? null,
  };
  const fail = (error: string): AgentRunOutcome<T> => ({
    ...base,
    status: "failed",
    error: redactSecrets(error).slice(0, MAX_ERROR_CHARS),
  });
  if (ended.launchError) return fail(ended.launchError);
  if (exit?.aborted) return { ...base, status: "cancelled", error: null };
  if (exit?.timedOut) return fail(`timed out after ${Math.round(options.timeoutMs / 1000)}s`);
  if (!result) {
    const detail = exit?.stderr.trim() || "no output";
    return fail(`claude exited with code ${exit?.code ?? "null"} before finishing: ${detail}`);
  }
  // `is_error` is how a run that reached the model and then failed reports
  // itself (an API error, the budget or turn limit); its text says which.
  if (result.isError) return fail(result.text || result.subtype || "the run reported an error");
  if (!options.outputSchema) return { ...base, status: "succeeded", error: null };
  const parsed = options.outputSchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    return fail(
      result.structuredOutput === null
        ? "the run finished without a structured answer"
        : `the run's answer did not match the expected shape: ${z.prettifyError(parsed.error)}`,
    );
  }
  return { ...base, status: "succeeded", output: redactDeep(parsed.data) as T, error: null };
}

/** Cancels a run in flight in this process. False when it isn't running here. */
export function cancelAgentRun(id: string, registry: AgentRunRegistry = agentRunRegistry): boolean {
  return registry.cancel(id);
}

export type AgentRunSummary = Omit<AgentRunRow, "events" | "instance">;

function summary(row: AgentRunRow): AgentRunSummary {
  const { events: _events, instance: _instance, ...rest } = row;
  return rest;
}

export async function getAgentRun(db: Db, id: string): Promise<AgentRunRow | null> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  return row ?? null;
}

export async function getAgentRunSummary(db: Db, id: string): Promise<AgentRunSummary | null> {
  const row = await getAgentRun(db, id);
  return row ? summary(row) : null;
}

/** The most recent runs, newest first, optionally of one kind and/or one target. */
export async function listAgentRuns(
  db: Db,
  filter: { kind?: string; targetKey?: string; limit: number },
): Promise<AgentRunSummary[]> {
  const conditions = [];
  if (filter.kind) conditions.push(eq(agentRuns.kind, filter.kind));
  if (filter.targetKey) conditions.push(eq(agentRuns.targetKey, filter.targetKey));
  const rows = await db
    .select()
    .from(agentRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentRuns.startedAt))
    .limit(filter.limit);
  return rows.map(summary);
}

/**
 * Fails the runs this instance left `running` when it last stopped. Their
 * processes went with it, so nothing will ever finish them. Another instance's
 * runs are left alone: they may well still be going. So are runs started after
 * `startedBefore` — this process's own, begun while the sweep waited its turn.
 */
export async function failInterruptedAgentRuns(
  db: Db,
  instance: string,
  startedBefore: Date,
): Promise<number> {
  const rows = await db
    .update(agentRuns)
    .set({
      status: "failed",
      error: "interrupted: Yarvis stopped while this run was in progress",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(agentRuns.status, "running"),
        eq(agentRuns.instance, instance),
        lt(agentRuns.startedAt, startedBefore),
      ),
    )
    .returning({ id: agentRuns.id });
  return rows.length;
}
