import { publish } from "../attention/hub.ts";
import { prNavTarget } from "../attention/navTarget.ts";
import { clearAttentionScope, createAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { PrGuideRow } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import { describeError, redactSecrets } from "../llm/errors.ts";
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

/** The attention item for a guide is keyed per PR, so re-generating coalesces. */
export const guideSessionKey = (ref: PrRef) => `pr-guide:${refKey(ref)}`;

const stepCount = (guide: PrGuideRow) =>
  guide.steps.length === 1 ? "1 step" : `${guide.steps.length} steps`;

/**
 * Tells the user a guide they asked for is ready to read. The item is keyed per
 * PR, so regenerating updates it, and reading the guide resolves it: a review
 * the user is partway through is work in progress, not something waiting on them.
 */
async function announceGuideReady(db: Db, ref: PrRef, guide: PrGuideRow): Promise<void> {
  const item = await createAttention(db, {
    source: "system",
    sessionKey: guideSessionKey(ref),
    // `completed` also resolves an earlier run's "Guided review failed" item.
    kind: "completed",
    category: "review",
    // The PR's title is the author's text, so it goes in the body, where it
    // can't pose as an app alert.
    title: "Guided review ready",
    body: guide.title ? `${guide.title}: ${stepCount(guide)}` : stepCount(guide),
    navTarget: prNavTarget(ref),
  });
  publish(item);
}

/** Resolves a PR's guide items once the user has started reading the guide. */
export async function resolveGuideAttention(db: Db, ref: PrRef): Promise<void> {
  const rows = await clearAttentionScope(db, { sessionKey: guideSessionKey(ref) }, "resolved");
  for (const row of rows) publish(row);
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
  await announceGuideReady(db, ref, guide);
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

/** PRs with a guide being written, so a second ask joins the first rather than paying twice. */
const guidesInFlight = new Set<string>();

/**
 * Claims the right to write `ref`'s guide. Returns the release, or null when
 * one is already being written. Per process, like the chat turn that asks.
 */
export function claimGuide(ref: PrRef): (() => void) | null {
  const key = refKey(ref);
  if (guidesInFlight.has(key)) return null;
  guidesInFlight.add(key);
  return () => guidesInFlight.delete(key);
}

/** Longest a background guide run may take before it is given up on. */
const GUIDE_TIMEOUT_MS = 15 * 60 * 1000;

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
    /** Replaces the provider, for tests. */
    source?: PrCodeSource;
    /** Replaces the guide agent, for tests. */
    runTour?: typeof generateTour;
  } = {},
): Promise<GuideKickoff> {
  // Claimed before the first await, so a second ask in the meantime joins this one.
  const release = claimGuide(ref);
  if (!release) return { status: "already-running" };
  // Once the background write owns the key, its .finally releases it; until then this finally does.
  let handedOff = false;
  try {
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
    if ("error" in resolved) return { status: "error", error: redactSecrets(resolved.error) };

    // An earlier failure's bell item would otherwise sit beside the new guide's.
    await clearAttentionScope(db, { sessionKey: guideSessionKey(ref) }, "resolved");
    handedOff = true;
    void writeGuide(db, config, {
      ref,
      source,
      resolved,
      title: detail.title,
      url: prWebUrl(ref, config.secrets.azureDevopsOrgUrl),
      signal: AbortSignal.timeout(GUIDE_TIMEOUT_MS),
      runTour: options.runTour,
    })
      .catch(async (e) => {
        console.error("[pr] guide generation failed:", describeError(e));
        await createAttention(db, {
          source: "system",
          sessionKey: guideSessionKey(ref),
          kind: "error",
          category: "review",
          title: "Guided review failed",
          body: `${detail.title}: the agent run failed. See Settings → Diagnostics.`,
          navTarget: prNavTarget(ref),
        }).catch(() => undefined);
      })
      .finally(release);
    return { status: "started" };
  } finally {
    if (!handedOff) release();
  }
}
