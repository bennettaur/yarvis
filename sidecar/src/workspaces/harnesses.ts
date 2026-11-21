import { basename } from "node:path";
import { z } from "zod";
import { readSection, settingsAreReadable } from "../settings/store.ts";

/**
 * The agent harnesses a workspace session can be started with, as the chat
 * agent sees them. The Rust core owns these settings (`src-tauri/src/harness.rs`)
 * and resolves an id at launch, so this only reads them to tell the model what
 * it can pick. Commands and environment are left out: the model chooses a
 * harness by id and never needs to see how it is launched.
 */

/** Id of the harness built from `agentName`/`agentCommand`. Mirrors the core. */
export const BUILTIN_HARNESS_ID = "claude";

/** The built-in harness's name while `agentName` is unset. Mirrors the core's
 *  `DEFAULT_AGENT_NAME`. */
const DEFAULT_AGENT_NAME = "Claude";

/** Mirrors the core's id rule, so a malformed id fails here with a clear error. */
export const harnessIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
  .describe(
    "Id of the agent harness to run, from list_agent_harnesses. Omit for the user's default. Only pass one the user asked for.",
  );

interface HarnessListing {
  id: string;
  name: string;
  /** `claude-code`, `pi`, `opencode` or `custom`, as the core reads it. */
  kind: string;
  isDefault: boolean;
}

interface StoredHarness {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  command?: unknown;
  assistantMayUse?: unknown;
  env?: unknown;
  secretEnv?: unknown;
}

/** Mirrors the core's `HEADLESS_REFUSED_ENV`: variables a verification run refuses from a harness. */
const HEADLESS_REFUSED_ENV = new Set([
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "NODE_OPTIONS",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_MODELS_PATH",
  "OPENCODE_MODELS_URL",
  "OPENCODE_DISABLE_MODELS_FETCH",
]);

/** Whether a stored harness sets a variable a verification run refuses. */
function setsRefusedEnv(h: StoredHarness): boolean {
  const plain = h.env && typeof h.env === "object" ? Object.keys(h.env) : [];
  const secret = Array.isArray(h.secretEnv) ? h.secretEnv : [];
  return [...plain, ...secret].some((key) => HEADLESS_REFUSED_ENV.has(String(key)));
}

/** Kinds the core knows; anything else it reads as `custom` (`HarnessKind::parse`). */
const KNOWN_KINDS = new Set(["claude-code", "pi", "opencode"]);

/** The built-in agent's command, as `pty::agent_command` resolves it. */
const DEFAULT_AGENT_COMMAND = "claude --permission-mode auto";

/** Whether a command line runs `binary` itself, past any `VAR=value` words. */
function runsProgram(command: string, binary: string): boolean {
  const program = command.split(/\s+/).find((word) => word && !word.includes("="));
  return !!program && basename(program) === binary;
}

function runsClaude(command: string): boolean {
  return runsProgram(command, "claude");
}

/** The kinds a verification run can drive, by the program each must run. */
const HEADLESS_PROGRAMS: Record<string, string> = { "claude-code": "claude", opencode: "opencode" };

/**
 * The kind the core gives the built-in harness: Claude Code when its command
 * runs `claude`, custom otherwise. Mirrors `harness::runs_claude_code`, since
 * only Claude Code takes Remote Control.
 */
function builtinKind(command: string): string {
  return runsClaude(command) ? "claude-code" : "custom";
}

interface KnownHarness extends HarnessListing {
  assistantMayUse: boolean;
  /** Whether a verification run can use it. */
  runsHeadless: boolean;
}

/**
 * Every harness the core will launch: the built-in one first, then the saved
 * ones, filtered the way the core's `resolve_stored` filters them.
 */
async function allHarnesses(env: NodeJS.ProcessEnv): Promise<KnownHarness[]> {
  const [stored, defaultId, agentName, agentCommand] = await Promise.all([
    readSection<unknown>("agentHarnesses").catch(() => undefined),
    readSection<unknown>("defaultAgentHarness").catch(() => undefined),
    readSection<unknown>("agentName").catch(() => undefined),
    readSection<unknown>("agentCommand").catch(() => undefined),
  ]);
  const entries = (Array.isArray(stored) ? stored : []).filter(
    (h): h is StoredHarness & { id: string; command: string } =>
      typeof h === "object" &&
      h !== null &&
      typeof h.id === "string" &&
      harnessIdSchema.safeParse(h.id).success &&
      h.id !== BUILTIN_HARNESS_ID &&
      typeof h.command === "string" &&
      h.command.trim().length > 0,
  );
  const ids = new Set(entries.map((h) => h.id));
  const effectiveDefault =
    typeof defaultId === "string" && ids.has(defaultId) ? defaultId : BUILTIN_HARNESS_ID;
  const builtinName =
    typeof agentName === "string" && agentName.trim() ? agentName.trim() : DEFAULT_AGENT_NAME;
  const builtinCommand =
    env.YARVIS_CLAUDE_COMMAND?.trim() ||
    (typeof agentCommand === "string" && agentCommand.trim()) ||
    DEFAULT_AGENT_COMMAND;
  const builtin = builtinKind(builtinCommand);
  return [
    {
      id: BUILTIN_HARNESS_ID,
      name: builtinName,
      kind: builtin,
      isDefault: effectiveDefault === BUILTIN_HARNESS_ID,
      assistantMayUse: true,
      // Verification has always run the built-in agent's Claude Code build,
      // whatever the interactive command is, so it is always offered.
      runsHeadless: true,
    },
    ...entries.map((h) => {
      const kind = typeof h.kind === "string" && KNOWN_KINDS.has(h.kind) ? h.kind : "custom";
      return {
        id: h.id,
        name: typeof h.name === "string" && h.name.trim() ? h.name.trim() : h.id,
        kind,
        isDefault: effectiveDefault === h.id,
        assistantMayUse: h.assistantMayUse === true,
        runsHeadless:
          kind in HEADLESS_PROGRAMS &&
          runsProgram(h.command, HEADLESS_PROGRAMS[kind] ?? "") &&
          !setsRefusedEnv(h),
      };
    }),
  ];
}

const toListing = ({ id, name, kind, isDefault }: KnownHarness): HarnessListing => ({
  id,
  name,
  kind,
  isDefault,
});

/**
 * The harnesses the assistant may start: the built-in one, the default, and
 * any the user marked "assistant may use". The core refuses the rest
 * (`harness::check_assistant_may_launch`), so listing them would only invite a
 * call that fails.
 */
export async function listAgentHarnesses(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessListing[]> {
  return (await allHarnesses(env)).filter((h) => h.isDefault || h.assistantMayUse).map(toListing);
}

/**
 * The harnesses a verification run can use: the built-in agent, then saved
 * Claude Code and OpenCode harnesses that run `claude` or `opencode` directly
 * and set no variable a run refuses, since a run drives the CLI with flags of
 * its own. Mirrors the core's `harness::headless_run_env`. The user picks
 * among them in Settings or on the Verification tab; the assistant can't pick
 * one.
 */
export async function listVerificationHarnesses(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ id: string; name: string; kind: string }[]> {
  return (await allHarnesses(env))
    .filter((h) => h.runsHeadless)
    .map(({ id, name, kind }) => ({
      id,
      name,
      // The built-in agent's checks always run its Claude Code build.
      kind: id === BUILTIN_HARNESS_ID ? "claude-code" : kind,
    }));
}

/**
 * Why a session tool can't launch with `harness` (or the default, when it is
 * omitted), or null when it can. Checked before a workspace is built, since
 * the core would refuse the same launch only after provisioning. No message
 * tells the model to pick another harness on its own: only the user or the
 * default may choose one.
 */
export async function harnessChoiceError(
  harness: string | undefined,
  remoteControl: boolean,
): Promise<string | null> {
  if (!harness && !remoteControl) return null;
  const listed = await listAgentHarnesses();
  const pick = harness ? listed.find((h) => h.id === harness) : listed.find((h) => h.isDefault);
  if (!pick) {
    return `"${harness}" is not a harness you may start; leave harness out for the default, or ask the user which agent they meant`;
  }
  if (remoteControl && pick.kind !== "claude-code") {
    // `pick` isn't Claude Code, so a Claude Code default is never `pick` itself.
    const fallback = listed.find((h) => h.isDefault && h.kind === "claude-code");
    const next = fallback
      ? `leave harness out to use the default, "${fallback.name}", and tell the user "${pick.name}" can't take Remote Control`
      : "ask the user which Claude Code harness to use";
    return `Remote Control needs a Claude Code harness, and "${pick.name}" isn't one; ${next}`;
  }
  return null;
}

/**
 * Whether `harness` is still one the assistant may start, for a kick-off that
 * stored it earlier. Settings that can't be read count as yes: the core still
 * decides at launch, and reading them as empty would drop the user's choice
 * for good.
 */
export async function harnessStillStartable(harness: string): Promise<boolean> {
  if (!(await settingsAreReadable())) return true;
  const listed = await listAgentHarnesses();
  return listed.some((h) => h.id === harness);
}
