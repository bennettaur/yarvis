import type { Tool } from "ai";
import { buildDelegationTools } from "../agents/tools.ts";
import { buildBrowserTools } from "../browser/tools.ts";
import { buildCheckBackTools, type CheckBackTurnContext } from "../checkBacks/tools.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { buildDigestTools } from "../digest/tools.ts";
import { buildEventTools } from "../events/tools.ts";
import { buildCalendarTools } from "../google/tools.ts";
import { buildHeadsDownTools } from "../headsDown/tools.ts";
import { buildHelpTools } from "../help/tools.ts";
import { buildJiraTools } from "../jira/tools.ts";
import type { MemoryService } from "../memory/index.ts";
import { buildMemoryTools } from "../memory/tools.ts";
import { buildPrReviewTools } from "../pr/reviewTools.ts";
import { buildProjectTools } from "../projects/tools.ts";
import { buildQuestionTools } from "../questions/tools.ts";
import { buildTodoTools } from "../todos/tools.ts";
import { buildWorkStreamTools } from "../workStreams/tools.ts";
import { buildWorkspaceTools } from "../workspaces/tools.ts";
import { type AttentionState, buildAttentionTool, newAttentionState } from "./attentionTools.ts";
import { buildTaskTools } from "./tools.ts";

/**
 * The one place the agent's built-in tool set is assembled.
 *
 * Two callers need the same list and must not drift: `runAgentTurn`, which binds
 * the tools to a live turn, and `agentTools/registry.ts`, which indexes their
 * names and descriptions so tool search and the Tool Manager know they exist. A
 * built-in missing from the registry is worse than missing from the turn — it
 * ends up present but never *active*, because the active set is computed from
 * registry policy — so both come from here.
 */

export interface BuiltinToolDeps {
  db: Db;
  config: Config;
  sessionId: string;
  memory: MemoryService;
  /** Collects a `request_attention` call for the caller to act on. */
  attention: AttentionState;
  /** Whether sessions this turn starts should be remotely controllable. */
  remoteControl: boolean;
  /**
   * Whether the user can answer a question from the attention bell. False on
   * Telegram, in a heads-down pass and in a delegated run: the question tools
   * are left out there rather than refused, so a pass keeps its own `ask_user`,
   * which never waits, as the only one.
   */
  atTheApp: boolean;
  /** A turn nobody is watching, a heads-down pass: what it records is marked as its own. */
  unattended?: boolean;
  /** What a check-back scheduled from this turn inherits. Absent off a chat turn. */
  checkBack?: CheckBackTurnContext;
}

/**
 * The built-ins grouped by the family that produced them.
 *
 * The grouping is derived from the factories rather than written down as name
 * lists, so it cannot drift from the tools themselves — which matters because
 * the registry seeds a *policy* per family, and a name in the wrong list would
 * silently make a tool unreachable or always-on.
 */
export function builtinToolFamilies(deps: BuiltinToolDeps): Record<string, Record<string, Tool>> {
  const { db, config, sessionId, memory, attention, remoteControl, atTheApp, unattended } = deps;
  const checkBack = deps.checkBack ?? { provider: null, model: null, attempt: 0 };
  return {
    tasks: buildTaskTools(db, sessionId),
    memory: buildMemoryTools(memory, sessionId),
    attention: buildAttentionTool(attention),
    checkBacks: buildCheckBackTools(db, sessionId, checkBack),
    questions: atTheApp ? buildQuestionTools(db, sessionId) : {},
    projects: buildProjectTools(db),
    todos: buildTodoTools(db),
    workStreams: buildWorkStreamTools(db, { unattended }),
    headsDown: buildHeadsDownTools(db),
    events: buildEventTools(db),
    digest: buildDigestTools(db, config),
    delegation: buildDelegationTools(db, config),
    workspaces: buildWorkspaceTools(db, config, { remoteControl }),
    jira: buildJiraTools(db, config, { remoteControl }),
    prReview: buildPrReviewTools(db),
    calendar: buildCalendarTools(db, config),
    browser: buildBrowserTools(),
    help: buildHelpTools(config),
  };
}

export function buildBuiltinTools(deps: BuiltinToolDeps): Record<string, Tool> {
  return Object.assign({}, ...Object.values(builtinToolFamilies(deps)));
}

/**
 * The same set, built with inert dependencies, for reading names and
 * descriptions. Safe because every factory defers its work to each tool's
 * `execute` — nothing here touches the database or a provider at construction
 * time. The config is a bare object rather than undefined because the workspace
 * and JIRA factories do read `config.secrets` while building.
 */
export function builtinToolMetadata(): Record<string, Tool> {
  return buildBuiltinTools(inertDeps());
}

/** The same grouping, built inert, for the registry's per-family policy seeding. */
export function builtinToolMetadataByFamily(): Record<string, Record<string, Tool>> {
  return builtinToolFamilies(inertDeps());
}

function inertDeps(): BuiltinToolDeps {
  return {
    db: undefined as unknown as Db,
    config: { secrets: {} } as unknown as Config,
    sessionId: "",
    memory: undefined as unknown as MemoryService,
    attention: newAttentionState(),
    // A metadata read starts no sessions, so remote control is irrelevant here —
    // it only shapes wording in two tool descriptions.
    remoteControl: false,
    atTheApp: true,
  };
}
