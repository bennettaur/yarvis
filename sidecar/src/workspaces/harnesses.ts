import { basename } from "node:path";
import { z } from "zod";
import { readSection } from "../settings/store.ts";

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
}

/** Kinds the core knows; anything else it reads as `custom` (`HarnessKind::parse`). */
const KNOWN_KINDS = new Set(["claude-code", "pi", "opencode"]);

/** The built-in agent's command, as `pty::agent_command` resolves it. */
const DEFAULT_AGENT_COMMAND = "claude --permission-mode auto";

/**
 * The kind the core gives the built-in harness: Claude Code when its command
 * runs `claude` (past any `VAR=value` words), custom otherwise. Mirrors
 * `harness::runs_claude_code`, since only Claude Code takes Remote Control.
 */
function builtinKind(command: string): string {
  const program = command.split(/\s+/).find((word) => word && !word.includes("="));
  return program && basename(program) === "claude" ? "claude-code" : "custom";
}

/**
 * The harnesses the assistant may start: the built-in one, the default, and
 * any the user marked "assistant may use". The core refuses the rest
 * (`harness::check_assistant_may_launch`), so listing them would only invite a
 * call that fails. Entries are filtered the way the core's `resolve_stored`
 * filters them, so an id listed here is one the core will launch.
 */
export async function listAgentHarnesses(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessListing[]> {
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
  return [
    {
      id: BUILTIN_HARNESS_ID,
      name: builtinName,
      kind: builtinKind(builtinCommand),
      isDefault: effectiveDefault === BUILTIN_HARNESS_ID,
    },
    ...entries
      .filter((h) => h.id === effectiveDefault || h.assistantMayUse === true)
      .map((h) => ({
        id: h.id,
        name: typeof h.name === "string" && h.name.trim() ? h.name.trim() : h.id,
        kind: typeof h.kind === "string" && KNOWN_KINDS.has(h.kind) ? h.kind : "custom",
        isDefault: effectiveDefault === h.id,
      })),
  ];
}
