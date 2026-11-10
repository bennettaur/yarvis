/**
 * The flow diagram: a headless Claude Code run over a review PR's checkout
 * that draws the flow the change sits in as a Mermaid flowchart. It runs as
 * the `yarvis-review:flow-diagram` agent, on its own, so a reviewer can ask
 * for a diagram without paying for a verification report.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type AgentRunSummary, getAgentRunSummary, startClaudeRun } from "../agentRuns/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { describeError } from "../llm/errors.ts";
import { boundedText } from "./agentContext.ts";
import { PATCH_LIMITS, READER_BUDGET_BYTES, writePatchFiles } from "./patchFiles.ts";
import { getReviewPr, type ReviewDeps, reviewPatchSources } from "./service.ts";
import {
  buildVerificationMaterial,
  latestRunId,
  requireCheckout,
  targetKeyFor,
  type VerificationDeps,
  writeReviewContext,
} from "./verification.ts";

export const FLOW_DIAGRAM_RUN_KIND = "pr-flow-diagram";

/** The plugin agent the run's main thread runs as. */
export const FLOW_DIAGRAM_AGENT = "yarvis-review:flow-diagram";

/** Past this a diagram is dropped rather than cut, since a cut one doesn't render. */
export const MAX_MERMAID_CHARS = 6000;

export const flowDiagramSchema = z
  .object({
    title: boundedText(100),
    explanation: boundedText(700),
    mermaid: z
      .string()
      .meta({ description: `A Mermaid flowchart, at most ${MAX_MERMAID_CHARS} characters.` }),
  })
  .transform((flow) =>
    flow.mermaid.length > MAX_MERMAID_CHARS
      ? { ...flow, mermaid: "", tooLarge: true }
      : { ...flow, mermaid: flow.mermaid.trim() },
  );

export type FlowDiagram = z.output<typeof flowDiagramSchema>;

export const FLOW_DIAGRAM_CONTEXT_DIR_PREFIX = "yarvis-flow-diagram-";

/** Longest a run can last, past which nothing still reads its context. */
export const FLOW_DIAGRAM_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Read-only, with no subagents: the agent reads the patches and the checkout itself. */
const ALLOWED_TOOLS = ["Read", "Grep", "Glob"];
const DISALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
];
/** The agent is told to stop at 20 calls in the checkout; this leaves room for the patches. */
const MAX_TURNS = 40;

/** The prompt holds only where the context is and how much patch to read. No PR text. */
export function flowDiagramPrompt(contextDir: string): string {
  return [
    "Draw the flow diagram for the pull request checked out in the working directory, as " +
      "your instructions describe, and answer with the structured output.",
    "",
    `REVIEW_CONTEXT=${contextDir}`,
    `READ_BUDGET_KB=${Math.round(READER_BUDGET_BYTES / 1024)}`,
  ].join("\n");
}

/** One check-and-start at a time per PR, so two clicks can't start two runs. */
const withPrLock = createKeyedLock();

export interface StartedFlowDiagram {
  runId: string;
  /** True when a run for this PR was already going and nothing new started. */
  existing: boolean;
}

/**
 * Starts a flow diagram run for a review PR, or returns the one already
 * running for it. Needs the worktree checked out, since the agent follows the
 * flow through the files.
 */
export async function startFlowDiagram(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  reviewDeps: ReviewDeps,
  deps: VerificationDeps,
): Promise<StartedFlowDiagram> {
  const { refKey } = await getReviewPr(db, workspaceId, prId);
  return withPrLock(refKey, async () => {
    const pr = await getReviewPr(db, workspaceId, prId);
    const headSha = requireCheckout(config, pr);
    const running = await latestRunId(db, refKey, "running", FLOW_DIAGRAM_RUN_KIND);
    if (running) return { runId: running, existing: true };

    const [{ sources }, detail, settings] = await Promise.all([
      reviewPatchSources(config, pr, reviewDeps, PATCH_LIMITS.maxPatchBytes),
      deps.loadDetail(pr.ref).catch((e) => {
        // The description helps pick the flow but isn't needed to draw it.
        console.error("[flow-diagram] could not load PR details:", describeError(e));
        return null;
      }),
      deps.settings(),
    ]);

    const contextDir = mkdtempSync(join(tmpdir(), FLOW_DIAGRAM_CONTEXT_DIR_PREFIX));
    const removeContext = () => rmSync(contextDir, { recursive: true, force: true });
    try {
      const index = await writePatchFiles(contextDir, sources, { tag: "diff" });
      // The same pr.md and index.md the verification agents read, which the
      // agent's shared instructions describe.
      writeReviewContext(
        contextDir,
        buildVerificationMaterial(
          { ref: pr.ref, headSha, detail, fallbackTitle: pr.title, index, sections: [] },
          contextDir,
        ),
      );
      const handle = await startClaudeRun(
        db,
        {
          kind: FLOW_DIAGRAM_RUN_KIND,
          targetKey: targetKeyFor(refKey, headSha),
          cwd: pr.worktreePath,
          addDirs: [contextDir],
          prompt: flowDiagramPrompt(contextDir),
          outputSchema: flowDiagramSchema,
          plugins: ["yarvis-review"],
          agent: FLOW_DIAGRAM_AGENT,
          allowedTools: ALLOWED_TOOLS,
          disallowedTools: DISALLOWED_TOOLS,
          model: settings.model,
          maxTurns: MAX_TURNS,
          timeoutMs: FLOW_DIAGRAM_RUN_TIMEOUT_MS,
          meta: { workspaceId, prId, refKey, headSha, detailLoaded: detail !== null },
        },
        deps.run,
      );
      void handle.done
        .catch((e) => console.error("[flow-diagram] run failed to settle:", e))
        .finally(removeContext);
      return { runId: handle.id, existing: false };
    } catch (e) {
      removeContext();
      throw e;
    }
  });
}

export interface LatestFlowDiagram {
  run: (AgentRunSummary & { live: boolean }) | null;
  /** The PR's head now. */
  headSha: string | null;
  /** True when the run was made against that head. */
  current: boolean;
  /** The newest run that finished with a diagram, so a failed re-run doesn't hide the last one. */
  lastSucceeded: { run: AgentRunSummary; headSha: string | null; current: boolean } | null;
}

/** The PR's most recent flow diagram run and last good diagram. */
export async function latestFlowDiagram(
  db: Db,
  workspaceId: string,
  prId: string,
  isLive: (id: string) => boolean,
): Promise<LatestFlowDiagram> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const id = await latestRunId(db, pr.refKey, undefined, FLOW_DIAGRAM_RUN_KIND);
  const run = id ? await getAgentRunSummary(db, id) : null;
  const isCurrent = (r: AgentRunSummary) =>
    pr.headSha !== null && r.targetKey === targetKeyFor(pr.refKey, pr.headSha);
  const succeededId =
    run?.status === "succeeded"
      ? run.id
      : await latestRunId(db, pr.refKey, "succeeded", FLOW_DIAGRAM_RUN_KIND);
  const succeeded =
    succeededId === run?.id ? run : succeededId ? await getAgentRunSummary(db, succeededId) : null;
  return {
    run: run ? { ...run, live: isLive(run.id) } : null,
    headSha: pr.headSha,
    current: run !== null && isCurrent(run),
    lastSucceeded: succeeded
      ? {
          run: succeeded,
          headSha: (succeeded.meta as { headSha?: string }).headSha ?? null,
          current: isCurrent(succeeded),
        }
      : null,
  };
}
