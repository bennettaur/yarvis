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
  kind: string;
  isDefault: boolean;
}

interface StoredHarness {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  command?: unknown;
}

const KNOWN_KINDS = new Set(["claude-code", "pi", "opencode"]);

/** The configured harnesses, the built-in one first. */
export async function listAgentHarnesses(): Promise<HarnessListing[]> {
  const [stored, defaultId, agentName] = await Promise.all([
    readSection<unknown>("agentHarnesses").catch(() => undefined),
    readSection<unknown>("defaultAgentHarness").catch(() => undefined),
    readSection<unknown>("agentName").catch(() => undefined),
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
  return [
    {
      id: BUILTIN_HARNESS_ID,
      name: builtinName,
      kind: "built-in",
      isDefault: effectiveDefault === BUILTIN_HARNESS_ID,
    },
    ...entries.map((h) => ({
      id: h.id,
      name: typeof h.name === "string" && h.name.trim() ? h.name.trim() : h.id,
      kind: typeof h.kind === "string" && KNOWN_KINDS.has(h.kind) ? h.kind : "custom",
      isDefault: effectiveDefault === h.id,
    })),
  ];
}
