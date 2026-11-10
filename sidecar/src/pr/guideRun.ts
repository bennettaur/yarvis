import { clearAttentionScope, createAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { AttentionNavTarget, PrGuideRow } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import { describeError } from "../llm/errors.ts";
import { modelCompactAtTokens, resolveModelWithOllama } from "../llm/providers.ts";
import { getGuide, isStale, saveGuide } from "./guides.ts";
import { type PrModelFeature, resolvePrModel } from "./models.ts";
import { prWebUrl } from "./resolveConflicts.ts";
import { type PrCodeSource, prSourceFor } from "./source.ts";
import { generateTour } from "./tour.ts";
import { type PrRef, refKey } from "./types.ts";

/**
 * Writing a guided review, shared by the PRs tab's route and the assistant's
 * `start_pr_guided_review` tool so both save, notify and log the same way.
 */

/** Where the attention stream should send the user for this pull request. */
export function navTargetFor(ref: PrRef): AttentionNavTarget {
  return ref.provider === "github"
    ? { type: "pr", owner: ref.owner, repo: ref.repo, number: ref.number }
    : { type: "azure-pr", org: ref.org, project: ref.project, repo: ref.repo, prId: ref.prId };
}

/** The attention item for a guide is keyed per PR, so re-generating coalesces. */
export const guideSessionKey = (ref: PrRef) => `pr-guide:${refKey(ref)}`;

const stepLabel = (guide: PrGuideRow) =>
  `Step ${guide.currentStep + 1} of ${guide.steps.length}` +
  (guide.steps[guide.currentStep] ? ` · ${guide.steps[guide.currentStep]!.path}` : "");

/**
 * Keeps the attention stream in step with a guide's progress. The item
 * coalesces on (sessionKey, kind), so regenerating or advancing updates the
 * one live entry rather than stacking. Reaching the last step resolves it —
 * the review is no longer in progress, and a finished guide sitting in the
 * panel would read as outstanding work.
 */
export async function syncGuideAttention(db: Db, ref: PrRef, guide: PrGuideRow): Promise<void> {
  const sessionKey = guideSessionKey(ref);
  const finished = guide.currentStep >= guide.steps.length - 1;
  if (finished) {
    await clearAttentionScope(db, { sessionKey }, "resolved");
    return;
  }
  await createAttention(db, {
    source: "system",
    sessionKey,
    kind: "info",
    title: guide.title ? `Reviewing ${guide.title}` : "PR review in progress",
    body: stepLabel(guide),
    navTarget: navTargetFor(ref),
  });
}

export type ResolvedPrModel = { selection: { provider: string; model: string } } & Awaited<
  ReturnType<typeof resolveModelWithOllama>
>;

/**
 * Resolves the model an agent run should use: the one the caller names, else
 * the one saved for `feature` in Settings, else the default chat model.
 * Returns a message rather than throwing so a caller can pass on something the
 * user can act on — "no LLM provider is configured" is a settings problem, not
 * a server fault.
 */
export async function resolvePrRunModel(
  config: Config,
  feature: PrModelFeature,
  providerId?: string,
  modelId?: string,
): Promise<ResolvedPrModel | { error: string }> {
  const fallback = await resolvePrModel(config, feature);
  const provider = providerId ?? fallback?.provider;
  const model = modelId ?? fallback?.model;
  if (!provider || !model) return { error: "no LLM provider is configured" };
  try {
    // Wrapped rather than returned bare: a resolved model can itself be a
    // string, so an `"error" in x` check would not tell the two apart.
    return {
      selection: { provider, model },
      ...(await resolveModelWithOllama(config, provider, model)),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface WriteGuideInput {
  ref: PrRef;
  source: PrCodeSource;
  resolved: ResolvedPrModel;
  title?: string | null;
  url?: string | null;
  signal?: AbortSignal;
  /** Replaces the guide agent, for tests. */
  runTour?: typeof generateTour;
}

/**
 * Runs the guide agent and saves what it hands in, replacing any guide the PR
 * had. Throws what the agent run throws; callers redact before showing it.
 */
export async function writeGuide(
  db: Db,
  config: Config,
  input: WriteGuideInput,
): Promise<{ guide: PrGuideRow; headSha: string }> {
  const { ref, source, resolved, title, url } = input;
  const { provider, model } = resolved.selection;
  const { steps, headSha, graph } = await (input.runTour ?? generateTour)(resolved.model, source, {
    signal: input.signal,
    // An Ollama model writes its final answer through Ollama's own API,
    // which holds the output to the tour's schema.
    ollama: resolved.ollama ?? undefined,
    modelName: model,
    contextTokens: await modelCompactAtTokens(config, provider, model),
  });
  const guide = await saveGuide(db, { ref, headSha, steps, graph, title, url });
  await syncGuideAttention(db, ref, guide);
  void emitEvent(db, {
    type: "pr.guide.generated",
    source: ref.provider,
    payload: { ref: refKey(ref), title, url, steps: steps.length },
  });
  return { guide, headSha };
}

export type GuideKickoff =
  | { status: "started" }
  | { status: "already-running" }
  /** A guide is already saved; writing another would throw away the reader's place in it. */
  | { status: "exists"; stale: boolean; progress: string }
  | { status: "error"; error: string };

/** PRs with a guide being written by {@link kickOffGuide}, so a second ask joins the first. */
const guidesInFlight = new Set<string>();

/**
 * Starts writing a guide in the background and answers at once. The guide
 * shows up in the PRs tab and in the attention bell when it is saved.
 * `regenerate` replaces a guide the PR already has.
 */
export async function kickOffGuide(
  db: Db,
  config: Config,
  ref: PrRef,
  options: {
    regenerate?: boolean;
    /** Replace the provider and the guide agent, for tests. */
    source?: PrCodeSource;
    runTour?: typeof generateTour;
  } = {},
): Promise<GuideKickoff> {
  const key = refKey(ref);
  if (guidesInFlight.has(key)) return { status: "already-running" };

  const source = options.source ?? prSourceFor(config, ref);
  if ("error" in source) return { status: "error", error: source.error };
  const detail = await source.detail();

  if (!options.regenerate) {
    const existing = await getGuide(db, ref);
    if (existing) {
      return {
        status: "exists",
        stale: isStale(existing, detail.headSha),
        progress: `step ${existing.currentStep + 1} of ${existing.steps.length}`,
      };
    }
  }

  const resolved = await resolvePrRunModel(config, "guide");
  if ("error" in resolved) return { status: "error", error: resolved.error };

  guidesInFlight.add(key);
  const title = detail.title;
  void writeGuide(db, config, {
    ref,
    source,
    resolved,
    title,
    url: prWebUrl(ref, config.secrets.azureDevopsOrgUrl),
    runTour: options.runTour,
  })
    .catch(async (e) => {
      console.error("[pr] guide generation failed:", describeError(e));
      await createAttention(db, {
        source: "system",
        sessionKey: guideSessionKey(ref),
        kind: "error",
        title: "Guided review failed",
        body: `${title}: the agent run failed. See Settings → Diagnostics.`,
        navTarget: navTargetFor(ref),
      }).catch(() => undefined);
    })
    .finally(() => guidesInFlight.delete(key));
  return { status: "started" };
}
